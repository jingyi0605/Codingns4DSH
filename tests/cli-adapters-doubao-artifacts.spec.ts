import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { DoubaoArtifactCollector } from '../data/build/dist/host/cli-adapters/doubao-artifacts.js'
import { doubaoArtifactDirectory, doubaoArtifactName, saveDoubaoArtifact, DOUBAO_ARTIFACT_MAX_BYTES } from '../data/build/dist/host/cli-adapters/doubao-artifact-store.js'
import { DoubaoAppDriver } from '../data/build/dist/host/cli-adapters/doubao-driver.js'
import { installDoubaoRuntime } from '../data/build/dist/host/cli-adapters/doubao-runtime.js'

const url = 'https://p3-flow-sign.byteimg.com/tos/test?x-signature=SECRET'
const artifact = { id: 'f1', name: 'report.bin', url, size: 4 }
const input = { sessionId: 'artifact-test', prompt: '生成文件', messages: [], modelId: 'doubao-work' }
async function temporary(t: any) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'doubao-artifact-test-')))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('产物按块补丁合并、替换和撤回，去重下载且不采用云端路径', () => {
  const c = new DoubaoArtifactCollector()
  c.accept('a', 10020, { file_block: { name: '旧名称.txt', path: '/etc/passwd', uri: 'PRIVATE', url } }, false)
  c.accept('a', 10020, { file_block: { size: '4' } }, false)
  assert.deepEqual(c.list(), [{ id: 'a', name: '旧名称.txt', url, size: 4 }])
  c.accept('b', 10020, { file_block: { name: '相同.bin', url } }, false)
  assert.equal(c.list().length, 1)
  c.accept('a', 10020, {}, true)
  assert.equal(c.list()[0].size, 4, '单独结束补丁不能清空文件信息')
  c.accept('a', 10020, { file_block: { name: '替换.bin' } }, true)
  assert.deepEqual(c.list()[0], { id: 'a', name: '替换.bin', url: '' })
  c.remove('a'); c.remove('b')
  assert.deepEqual(c.list(), [])
  for (let i = 0; i < 20; i++) c.accept(String(i), 10020, {}, false)
  assert.throws(() => c.accept('overflow', 10020, {}, false), /20/u)
})

test('保存真实二进制并校验散列，同名文件和符号链接不覆盖，临时文件不残留', async t => {
  const root = await temporary(t)
  const outside = await temporary(t)
  const bytes = Buffer.from(Array.from({ length: 140_000 }, (_, i) => i % 256))
  const bridge: any = { async download() { return new Response(bytes) } }
  const a = { ...artifact, name: '../../report.bin', size: bytes.length }
  await writeFile(path.join(outside, 'original'), '原有内容')
  await symlink(path.join(outside, 'original'), path.join(root, 'report.bin'))
  const saved = await saveDoubaoArtifact(bridge, a, root, new AbortController().signal)
  assert.equal(saved.path, path.join(root, 'report (1).bin'))
  assert.deepEqual(await readFile(saved.path), bytes)
  assert.equal(saved.size, bytes.length)
  assert.equal(saved.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(await readFile(path.join(outside, 'original'), 'utf8'), '原有内容')
  const again = await saveDoubaoArtifact(bridge, a, root, new AbortController().signal)
  assert.equal(again.path, path.join(root, 'report (2).bin'))
  assert.deepEqual((await readdir(root)).sort(), ['report (1).bin', 'report (2).bin', 'report.bin'])
})

test('跨平台产物名限制、明确的工作区权限和绝对目录缺一不可', async t => {
  const root = await temporary(t)
  assert.equal(doubaoArtifactName('C:\\temp\\..\\CON.txt'), '_CON.txt')
  assert.equal(doubaoArtifactName('../../目录/报告?.txt'), '报告_.txt')
  assert.equal(doubaoArtifactName('..'), '豆包产物')
  assert.ok(Buffer.byteLength(doubaoArtifactName('报告'.repeat(500) + '.pdf')) <= 180)
  for (const permission of [undefined, {}, { sandboxMode: 'read-only' }]) {
    await assert.rejects(doubaoArtifactDirectory({ ...input, cwd: root, permission }), /权限/u)
  }
  assert.deepEqual(await readdir(root), [], '没有写入权限时不能创建 Doubao 目录')
  const writable = { ...input, cwd: root, permission: { sandboxMode: 'workspace-write' } }
  assert.equal(await doubaoArtifactDirectory(writable), path.join(root, 'Doubao'))
  assert.equal(await doubaoArtifactDirectory(writable), path.join(root, 'Doubao'), '已有目录应复用')
  assert.deepEqual(await readdir(root), ['Doubao'])
  for (const cwd of [undefined, '.', path.join(root, '不存在')]) {
    await assert.rejects(doubaoArtifactDirectory({ ...input, cwd, permission: { sandboxMode: 'danger-full-access' } }), /路径|目录/u)
  }
  const blocked = await temporary(t)
  const outside = await temporary(t)
  await writeFile(path.join(blocked, 'Doubao'), '保留已有文件')
  await assert.rejects(doubaoArtifactDirectory({ ...writable, cwd: blocked }), /Doubao 目录/u)
  assert.equal(await readFile(path.join(blocked, 'Doubao'), 'utf8'), '保留已有文件')
  await rm(path.join(blocked, 'Doubao'))
  await symlink(outside, path.join(blocked, 'Doubao'), 'dir')
  await assert.rejects(doubaoArtifactDirectory({ ...writable, cwd: blocked }), /Doubao 目录/u)
  assert.deepEqual(await readdir(outside), [], '不能通过符号链接写出项目')
})

test('截断下载只重试 GET，失败和取消不发布半个文件，也不残留临时文件', async t => {
  const root = await temporary(t)
  let downloads = 0
  const bridge: any = { async download() { downloads++; return new Response(new Uint8Array([1, 2])) } }
  await assert.rejects(saveDoubaoArtifact(bridge, artifact, root, new AbortController().signal), /校验失败/u)
  assert.equal(downloads, 2)
  assert.deepEqual(await readdir(root), [])
  await assert.rejects(saveDoubaoArtifact(bridge, { ...artifact, size: DOUBAO_ARTIFACT_MAX_BYTES + 1 }, root, new AbortController().signal), /64 MiB/u)
  assert.equal(downloads, 2)
  const abort = new AbortController()
  const cancelling: any = { async download() { abort.abort(); return new Response(new Uint8Array([1, 2, 3, 4])) } }
  await assert.rejects(saveDoubaoArtifact(cancelling, artifact, root, abort.signal), { name: 'AbortError' })
  assert.deepEqual(await readdir(root), [])
})

test('瞬断仅重试文件下载，第二次成功后发布完整文件', async t => {
  const root = await temporary(t)
  let calls = 0
  const bridge: any = { async download() {
    if (++calls === 1) return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.error(new Error('SECRET 网络详情')) } }))
    return new Response(new Uint8Array([1, 2, 3, 4]))
  } }
  const saved = await saveDoubaoArtifact(bridge, artifact, root, new AbortController().signal)
  assert.deepEqual(await readFile(saved.path), Buffer.from([1, 2, 3, 4]))
  assert.equal(calls, 2)
})

function fakeDriver(options: { end?: boolean; fail?: boolean; cancelled?: boolean } = {}) {
  let posts = 0
  let downloads = 0
  let closed = false
  let cancelDownload: (() => void) | undefined
  const bridge = {
    async create() { return { id: '101', section: '201', index: 0 } },
    async history() { return { id: '101', section: '201', index: 2, found: true } },
    async stop() { throw new Error('云端已完成，不应调用停止工具') },
    async cancel() { cancelDownload?.() },
    async close() { closed = true; cancelDownload?.() },
    async download() {
      downloads++
      if (options.fail) throw new Error('SECRET 不可公开的签名')
      return new Response(options.cancelled ? new ReadableStream({ start(c) { cancelDownload = () => c.error(new Error('cancelled')) } }) : new Uint8Array([1, 2, 3, 4]))
    },
    fetch: async () => {
      posts++
      const frames = [['SSE_ACK', { ack_client_meta: { conversation_id: '101' } }], ['STREAM_MSG_NOTIFY', { message_id: '301', content: { content_block: [
        { block_id: artifact.id, block_type: 10020, is_finish: true, content: { file_block: { ...artifact, size: '4' } } },
      ] } }], ...(options.end === false ? [] : [['SSE_REPLY_END', { end_type: 3 }]])]
      return new Response(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    },
  }
  return { driver: new DoubaoAppDriver({ detect: async () => ({ installed: true, version: 'test', command: null }), connect: async () => bridge }),
    stats: () => ({ posts, downloads, closed }) }
}

async function run(driver: DoubaoAppDriver, value: any) {
  const events = []
  for await (const event of driver.executeTurn(value)) events.push(event)
  return events
}

test('驱动在 SSE 成功后保存并给出本地链接，保存失败不能谎报任务全部成功', async t => {
  const root = await temporary(t)
  await writeFile(path.join(root, 'report.bin'), '保留项目根目录文件')
  const value = { ...input, cwd: root, permission: { sandboxMode: 'workspace-write' } }
  const success = fakeDriver()
  const events = await run(success.driver, value)
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
  assert.equal(events.filter(e => e.type === 'tool-event' && e.toolName === '保存豆包产物' && e.status === 'completed').length, 1)
  assert.ok(events.some(e => e.type === 'text-delta' && e.text.includes(path.join(root, 'Doubao', 'report.bin'))))
  assert.equal(await readFile(path.join(root, 'report.bin'), 'utf8'), '保留项目根目录文件')
  assert.doesNotMatch(JSON.stringify(events), /SECRET|x-signature/u)
  assert.deepEqual(success.stats(), { posts: 1, downloads: 1, closed: true })
  const failed = fakeDriver({ fail: true })
  const failure = await run(failed.driver, value)
  assert.equal(failure.at(-1).failure.code, 'DOUBAO_ARTIFACT_SAVE_FAILED')
  assert.equal(failure.at(-1).reason, 'error')
  assert.doesNotMatch(JSON.stringify(failure), /SECRET/u)
  assert.deepEqual(failed.stats(), { posts: 1, downloads: 2, closed: true })
  assert.deepEqual((await readdir(root)).sort(), ['Doubao', 'report.bin'])
  assert.deepEqual(await readdir(path.join(root, 'Doubao')), ['report.bin'])
})

test('权限缺失、只读或流异常时禁止自动下载写入；云端结束后的取消只取消下载', async t => {
  const root = await temporary(t)
  for (const extra of [{}, { permission: { sandboxMode: 'read-only' } }]) {
    const fake = fakeDriver()
    const result = await run(fake.driver, { ...input, cwd: root, ...extra })
    assert.equal(result.at(-1).reason, 'error')
    assert.equal(fake.stats().downloads, 0)
  }
  const broken = fakeDriver({ end: false })
  const value = { ...input, cwd: root, permission: { sandboxMode: 'workspace-write' } }
  assert.equal((await run(broken.driver, value)).at(-1).failure.code, 'DOUBAO_TURN_FAILED')
  assert.equal(broken.stats().downloads, 0)
  assert.deepEqual(await readdir(root), [], '失败的云端任务不创建产物目录')
  const cancelled = fakeDriver({ cancelled: true })
  const events: any[] = []
  for await (const event of cancelled.driver.executeTurn(value)) {
    events.push(event)
    if (event.type === 'tool-event' && event.toolName === '保存豆包产物' && event.status === 'started') await cancelled.driver.interrupt(input.sessionId)
  }
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'cancel' })
  assert.doesNotMatch(JSON.stringify(events), /云端工具可能继续/u)
  assert.deepEqual(await readdir(root), ['Doubao'])
  assert.deepEqual(await readdir(path.join(root, 'Doubao')), [])
})

test('下载正在等网络字节时可以取消，等待中的读取器和临时文件均被释放', async t => {
  const root = await temporary(t)
  const fake = fakeDriver({ cancelled: true })
  const iterator = fake.driver.executeTurn({ ...input, cwd: root, permission: { sandboxMode: 'workspace-write' } })[Symbol.asyncIterator]()
  try {
    for (;;) {
      const { value } = await iterator.next()
      if (value.type === 'tool-event' && value.toolName === '保存豆包产物') break
    }
    const waiting = iterator.next()
    for (let i = 0; !fake.stats().downloads && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 2))
    assert.equal(fake.stats().downloads, 1)
    await fake.driver.interrupt(input.sessionId)
    assert.equal((await waiting).value.status, 'failed')
    assert.deepEqual((await iterator.next()).value, { type: 'finish', reason: 'cancel' })
  } finally { await iterator.return?.() }
  assert.deepEqual(await readdir(root), ['Doubao'])
  assert.deepEqual(await readdir(path.join(root, 'Doubao')), [])
  assert.equal(fake.stats().closed, true)
})

/** 运行正式序列化函数，模拟 App 模块出口和 fetch，不访问用户的 App/登录态。 */
async function runtime(fetch: typeof globalThis.fetch) {
  const holder = { flowApiOptions: { baseURL: 'https://www.doubao.com', getCommonParams() {}, getCommonHeaders() {} } }
  const definitions = [
    ['FlowApiOptions not initialized getCommonHeaders', { config: () => holder.flowApiOptions }],
    ['uplinkKey: downlinkKey: status_code:', { request: () => () => ({ code: 0 }) }],
    ['IMCMD_NOT_USED: PULL_SINGLE_CHAIN:', { commands: { CREATE_CONVERSATION: 1, BREAK_MSG: 2 } }],
    ['MSG_DIRECTION_UNKNOWN: ONE_TO_BOT_CHAT:', { directions: { MSG_DIRECTION_UNKNOWN: 0, OLDER: 1 } }],
    ['bot_id:a||"123"' + ' '.repeat(200), {}], ['"123"', { bot: '123' }],
  ]
  const require: any = (id: string) => definitions[Number(id)]![1]
  require.m = Object.fromEntries(definitions.map(([source], index) => [index, { toString: () => source }]))
  const context: any = { location: { host: 'doubao-background' }, fetch, URL, AbortController, AbortSignal, Uint8Array, setTimeout, clearTimeout,
    webpackChunkapp_flow_desktop_framework: Object.assign([], { push([, , callback]: any) { callback(require) } }) }
  await runInNewContext(`(${installDoubaoRuntime.toString()})('bridge')`, context)
  return context.bridge
}

test('App 内下载只允许已验证产物源，不携带认证、不跳转，真实字节按背压分块返回', async () => {
  const requests: any[] = []
  const bytes = new Uint8Array(140_000).fill(173)
  const bridge = await runtime(async (address, init) => { requests.push({ address: String(address), ...init }); return new Response(bytes) })
  try {
    for (const address of ['http://p3-flow-sign.byteimg.com/a', 'https://127.0.0.1/a', 'https://p3-flow-sign.byteimg.com.evil.test/a', 'https://u:p@p3-flow-sign.byteimg.com/a', 'file:///etc/passwd']) {
      await assert.rejects(bridge.download(address, bytes.length), /DOUBAO_DOWNLOAD_ORIGIN/u)
    }
    assert.equal(requests.length, 0)
    await bridge.download(url, bytes.length)
    assert.equal(requests[0].credentials, 'omit')
    assert.equal(requests[0].redirect, 'error')
    assert.equal(requests[0].headers, undefined)
    const chunks = []
    for (;;) { const chunk = await bridge.read(); if (chunk === null) break; assert.ok(chunk.length <= 65_536); chunks.push(Buffer.from(chunk)) }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes))
    await bridge.download(url, 2)
    await assert.rejects(bridge.read(), /DOUBAO_DOWNLOAD_TOO_LARGE/u)
  } finally { await bridge.dispose() }
})
