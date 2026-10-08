import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { DoubaoAppDriver } from '../data/build/dist/host/cli-adapters/doubao-driver.js'
import { DoubaoApp } from '../data/build/dist/host/cli-adapters/doubao-app.js'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'
import { createCodingNsNativeSessionBridge } from '../data/build/dist/host/native-session-bridge.js'

/** 显式运行才发送合成测试任务；只连接现有 App，禁止冷启动、重启和界面控制。 */
test('豆包正式驱动：快速、立即续聊、专家、云端产物及指定回答取消', {
  skip: process.env.CODINGNS_DOUBAO_LIVE !== '1', timeout: 150_000,
}, async () => {
  const app = new DoubaoApp()
  const driver = new DoubaoAppDriver({ detect: () => app.detect(), connect: (_launch, signal) => app.connect(false, signal) })
  const token = `Q73_${Date.now()}`
  const cwd = await mkdtemp(path.join(tmpdir(), 'doubao-live-'))
  const run = async (id: string, prompt: string, modelId = 'doubao-fast', providerSessionId?: string) => {
    const events: any[] = []
    for await (const event of driver.executeTurn({ sessionId: id, messages: [], prompt, modelId,
      effortId: 'default', serviceTierId: 'default',
      cwd, permission: { sandboxMode: 'workspace-write' },
      ...(providerSessionId ? { providerSessionId } : {}), signal: AbortSignal.timeout(60_000) })) events.push(event)
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
    let text = ''
    for (const event of events) {
      if (event.type === 'text-delta') text += event.text
      if (event.type === 'text-snapshot') text = event.text
    }
    return { text, events, id: events.find((event) => event.type === 'session-binding')?.providerSessionId as string }
  }
  try {
    assert.equal((await driver.detect()).installed, true)
    const first = await run(`spec0073-fast-${token}`, `请记住测试暗号 ${token}，只回复：连接通过。`)
    // 首轮只核验真实回答；模型可能换一种确认措辞，记忆正确性由下一轮随机暗号验证。
    assert.ok(first.text.trim().length > 0)
    // 不人为等待：正式恢复路径负责处理流关闭与历史落库之间的间隔。
    const resumed = await run(`spec0073-fast-${token}`, '刚才的测试暗号是什么？只回复暗号。', 'doubao-fast', first.id)
    assert.ok(resumed.text.includes(token)); assert.equal(resumed.id, first.id)
    assert.equal((await driver.probeSession({ providerSessionId: first.id })).state, 'available')
    const expert = await run(`spec0073-expert-${token}`, '求最小正整数 n，满足 n 除以 5 余 4，除以 7 余 6，除以 3 余 2，且 n 大于 50。请推导，最后只写数值。', 'doubao-expert')
    assert.match(expert.text, /104/u)
    assert.ok(expert.events.some((event) => event.type === 'reasoning-delta' && event.text))
    const work = await run(`spec0073-work-${token}`, '这是云端文件生成验收。请在你的云端环境创建 codingns-spec0073.txt，内容严格为 SPEC0073_OK，不要操作本机。请直接完成文件并交付。', 'doubao-work')
    assert.ok(work.events.some((event) => event.type === 'tool-event' && event.toolName === '豆包云端产物' && event.status === 'completed'))
    assert.ok(work.events.some((event) => event.type === 'tool-event' && event.toolName === '豆包云端文件操作'))
    const cancelled: any[] = []
    let requested = false
    for await (const event of driver.executeTurn({ sessionId: `spec0073-cancel-${token}`, messages: [], modelId: 'doubao-fast',
      effortId: 'default', serviceTierId: 'default',
      prompt: '请严格输出 200 行，每行格式为“序号：适配器取消测试正在进行”，不要省略。', signal: AbortSignal.timeout(25_000) })) {
      cancelled.push(event)
      if (!requested && event.type === 'text-delta') { requested = true; await driver.interrupt(`spec0073-cancel-${token}`) }
    }
    assert.equal(requested, true)
    assert.deepEqual(cancelled.at(-1), { type: 'finish', reason: 'cancel' })
    // 验收日志只包含计数与真假结论，不写原始回答、私有 URL 或鉴权信息。
    console.log(JSON.stringify({ fast: true, resume: true, expert: true, workArtifact: true, cancel: true,
      workToolEvents: work.events.filter((event) => event.type === 'tool-event').length }))
  } finally { await driver.dispose(); await rm(cwd, { recursive: true, force: true }) }
})

test('豆包真实 Host 入口同一会话连续三轮，收到 finish 即退出仍释放后台桥', {
  skip: process.env.CODINGNS_DOUBAO_LIVE !== '1', timeout: 90_000,
}, async () => {
  const app = new DoubaoApp()
  const closed: number[] = []
  let created = 0
  let historyReads = 0
  const driver = new DoubaoAppDriver({ detect: () => app.detect(), async connect(_launch, signal) {
    const bridge = await app.connect(false, signal)
    const index = closed.push(0) - 1
    return { fetch: bridge.fetch,
      download: (url, limit) => bridge.download(url, limit),
      async create(name) { created++; return bridge.create(name) },
      async history(id) { historyReads++; return bridge.history(id) },
      stop: (id, reply) => bridge.stop(id, reply), cancel: () => bridge.cancel(),
      async close() { await bridge.close(); closed[index]!++ } }
  } })
  const registry = new CodingNsCliAdapterRegistry([driver])
  const table = new CodingNsRpcTable()
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<any>) | undefined
  const features = new FeatureRegistry({ rpc: table, events: {
    on(name: string, next: typeof listener) {
      if (name === 'llm/stream') listener = next
      return () => { if (name === 'llm/stream') listener = undefined }
    },
  } })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  const token = `HOST73_${Date.now()}`
  const sessionId = `spec0073-host-${token}`
  let boundId: string | undefined
  try {
    await table.resolve('cli/session/set')!.handler('session/set', {
      sessionId, adapterId: 'doubao', modelId: 'doubao-fast', effortId: 'default', serviceTierId: 'default',
    })
    for (let turn = 0; turn < 3; turn++) {
      // 明确限定当前会话；“最初的暗号”可能得到 App 记忆中的更早测试值。
      // 后两轮不携带随机值，只能通过恢复的上下文得到完整答案。
      const prompt = turn === 0 ? `本会话临时校验值为 ${token}，回复已记住。`
        : '请原样重复本会话第一条用户消息中 HOST73_ 开头的完整字符串，只回复该字符串，不使用其他会话的记忆。'
      const chunks = []
      for await (const chunk of listener!({ sessionId, messages: [{ role: 'user', content: prompt }], signal: AbortSignal.timeout(25_000) }, async function* () {})) {
        chunks.push(chunk)
        if (chunk.type === 'finish') break
      }
      assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
      const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
      assert.ok(text.trim())
      const id = registry.getSession(sessionId).providerSessionId
      assert.ok(id)
      if (boundId) assert.equal(id, boundId)
      boundId = id
      assert.deepEqual(closed, Array(turn + 1).fill(1))
      assert.equal(created, 1, '续聊不能重新创建云端会话')
      assert.ok(historyReads >= turn, '续聊必须恢复原会话历史')
      if (turn > 0) assert.ok(text.includes(token), `第 ${turn + 1} 轮未返回当前会话的完整随机校验值`)
    }
    console.log(JSON.stringify({ hostTurns: 3, sameBinding: true, rememberedToken: true, bridgesClosed: closed.length }))
  } finally { await features.disable('cliAdapters') }
})

test('豆包真实工具展示：搜索、进度、网页读取和云端操作进入原生工具历史', {
  skip: process.env.CODINGNS_DOUBAO_LIVE !== '1', timeout: 180_000,
}, async () => {
  const app = new DoubaoApp()
  const driver = new DoubaoAppDriver({ detect: () => app.detect(), connect: (_launch, signal) => app.connect(false, signal) })
  const registry = new CodingNsCliAdapterRegistry([driver])
  const table = new CodingNsRpcTable()
  const sessions = new Map<string, any>()
  const cwd = await mkdtemp(path.join(tmpdir(), 'doubao-tools-live-'))
  const nativeSessions = createCodingNsNativeSessionBridge({ get(name: string) {
    return name === 'sessions' ? { get: (id: string) => sessions.get(id), list: () => [...sessions.values()] } : undefined
  } } as never)
  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<any>) | undefined
  const dshContext = { get(name: string) {
    if (name === 'agents') return { get: (id: string) => ({ session: sessions.get(id) }) }
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
    return undefined
  } }
  const features = new FeatureRegistry({ rpc: table, nativeSessions, dshContext: dshContext as never, events: {
    on(name: string, next: typeof listener) { if (name === 'llm/stream') listener = next; return () => {} },
  } })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  const cases = [
    { model: 'doubao-fast', prompt: '请实际联网搜索 Python pathlib 官方文档，给出一个功能说明及出处。', expected: ['豆包联网搜索', '豆包处理进度'] },
    { model: 'doubao-work', prompt: '这是云端工具验收。请读取 https://docs.python.org/3/library/pathlib.html 提取一条说明；在你的云端运行 Python 计算 1 至 10000 的平方和，把数值和说明写入 codingns-tools-check.txt 并交付。只用云端，不操作本机，直接完成。', expected: ['豆包网页读取', '豆包云端文件操作', '豆包云端产物'] },
  ]
  try {
    for (const [index, item] of cases.entries()) {
      const sessionId = `spec0073-tools-${Date.now()}-${index}`
      const events: any[] = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }, { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } }]
      sessions.set(sessionId, { header: { version: 4, cwd }, snapshotEvents: () => [...events], append(type: string, data: unknown) {
        const event = { type, seq: events.length, data }; events.push(event); return event
      } })
      await table.resolve('cli/session/set')!.handler('session/set', { sessionId, adapterId: 'doubao', modelId: item.model, effortId: 'default' })
      const chunks = []
      for await (const chunk of listener!({ sessionId, messages: [{ role: 'user', content: item.prompt }], signal: AbortSignal.timeout(90_000) }, async function* () {})) {
        chunks.push(chunk)
        if (chunk.type === 'finish') break
      }
      assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
      const calls = events.filter(event => event.type === 'tool/call')
      const results = events.filter(event => event.type === 'tool/result')
      const names = calls.map(event => event.data.name)
      for (const name of item.expected) assert.ok(names.includes(name), `未观测到工具：${name}`)
      assert.equal(results.length, calls.length)
      assert.equal(new Set(calls.map(event => event.data.callId)).size, calls.length)
      assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text.trim()))
      const output = results.map(event => event.data.message.content[0].text).join('\n')
      if (index === 0) assert.match(output, /docs.python.org/u)
      else { assert.match(output, /333383335000/u); assert.match(output, /codingns-tools-check.txt/u) }
      // 只记录工具类型和计数，测试正文、来源及云端产物地址不写控制台。
      console.log(JSON.stringify({ mode: item.model, tools: [...new Set(names)], calls: calls.length, results: results.length }))
    }
  } finally { await features.disable('cliAdapters'); await rm(cwd, { recursive: true, force: true }) }
})

test('豆包真实产物落盘：Host 项目 Doubao 目录、文本与 ZIP 字节校验、同名不覆盖及原生保存记录', {
  skip: process.env.CODINGNS_DOUBAO_ARTIFACT_LIVE !== '1', timeout: 180_000,
}, async () => {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'doubao-artifact-live-')))
  const outputDirectory = path.join(cwd, 'Doubao')
  const app = new DoubaoApp()
  const driver = new DoubaoAppDriver({ detect: () => app.detect(), connect: (_launch, signal) => app.connect(false, signal) })
  const table = new CodingNsRpcTable()
  const sessionId = `spec0073-artifact-${Date.now()}`
  const events: any[] = [{ type: 'turn/start', seq: 0, data: { turn: 1 } }, { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } }]
  const session = { header: { version: 4, cwd }, snapshotEvents: () => [...events], append(type: string, data: unknown) {
    const event = { type, seq: events.length, data }; events.push(event); return event
  } }
  const dshContext = { get(name: string) {
    if (name === 'sessions') return { get: () => session, list: () => [session] }
    if (name === 'agents') return { get: () => ({ session }) }
    if (name === 'sandboxPolicy') return { resolve: () => ({ mode: 'workspace-write' }) }
    return undefined
  } }
  let listener: any
  const features = new FeatureRegistry({ rpc: table, dshContext: dshContext as never,
    nativeSessions: createCodingNsNativeSessionBridge(dshContext as never),
    events: { on(name: string, next: unknown) { if (name === 'llm/stream') listener = next; return () => {} } } })
  features.register(createCliAdaptersFeature({ registry: new CodingNsCliAdapterRegistry([driver]) }))
  const token = `ARTIFACT_${Date.now()}`
  try {
    await mkdir(outputDirectory)
    await writeFile(path.join(outputDirectory, 'codingns-delivery.txt'), '不能覆盖的已有文件')
    await features.start('cliAdapters')
    await table.resolve('cli/session/set')!.handler('session/set', { sessionId, adapterId: 'doubao', modelId: 'doubao-work' })
    const chunks: any[] = []
    const prompt = `产物落盘验收：请用 Python 生成并交付恰好两个可下载文件。1. codingns-delivery.txt，UTF-8 文本内容为 ${token}。2. codingns-bytes.zip，使用 zipfile.ZIP_STORED，内部恰好一个 payload.bin，其内容为 bytes(range(256))*512。不要额外生成说明文件，直接交付。`
    for await (const chunk of listener({ sessionId, messages: [{ role: 'user', content: prompt }], signal: AbortSignal.timeout(150_000) }, async function* () {})) {
      chunks.push(chunk)
      if (chunk.type === 'finish') break
    }
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
    assert.equal(await readFile(path.join(outputDirectory, 'codingns-delivery.txt'), 'utf8'), '不能覆盖的已有文件')
    assert.equal((await readFile(path.join(outputDirectory, 'codingns-delivery (1).txt'), 'utf8')).replace(/^\uFEFF/u, '').trim(), token)
    const zip = await readFile(path.join(outputDirectory, 'codingns-bytes.zip'))
    // 用中央目录给出的尺寸定位数据，兼容 ZIP 的尾部 data descriptor。
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    assert.ok(central > 0)
    const offset = zip.readUInt32LE(central + 42)
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28)
    const compressed = zip.subarray(start, start + zip.readUInt32LE(central + 20))
    const bytes = zip.readUInt16LE(central + 10) === 8 ? inflateRawSync(compressed) : compressed
    assert.deepEqual(bytes, Buffer.from(Array.from({ length: 256 * 512 }, (_, i) => i % 256)))
    const saves = events.filter(event => event.type === 'tool/call' && event.data.name === '保存豆包产物')
    assert.equal(saves.length, 2)
    const saved = events.filter(event => event.type === 'tool/result' && saves.some(call => call.data.callId === event.data.message.toolCallId))
      .map(event => JSON.parse(event.data.message.content[0].text))
    assert.equal(saved.length, 2, '每个保存调用都必须具有原生结果，不能只验证调用声明')
    for (const item of saved) {
      const file = await readFile(item.path)
      assert.equal(path.dirname(item.path), outputDirectory)
      assert.equal(file.length, item.size)
      assert.equal(createHash('sha256').update(file).digest('hex'), item.sha256)
    }
    assert.deepEqual(await readdir(cwd), ['Doubao'])
    assert.equal((await readdir(outputDirectory)).length, 3)
    assert.doesNotMatch(JSON.stringify(saved), /x-signature|byteimg\.com/u)
    console.log(JSON.stringify({ artifactFiles: saved.length, binaryBytes: bytes.length, sameNamePreserved: true, hostProjectDirectory: true, nativeSaveResults: saved.length }))
  } finally { await features.disable('cliAdapters'); await driver.dispose(); await rm(cwd, { recursive: true, force: true }) }
})
