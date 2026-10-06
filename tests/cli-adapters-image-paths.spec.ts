import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import test, { type TestContext } from 'node:test'
import { AntigravityDriver } from '../data/build/dist/host/cli-adapters/antigravity-driver.js'
import { CommandCodeDriver } from '../data/build/dist/host/cli-adapters/command-code-driver.js'
import { GeminiCliDriver } from '../data/build/dist/host/cli-adapters/gemini-driver.js'
import { KimiCliDriver } from '../data/build/dist/host/cli-adapters/kimi-driver.js'
import { MiniMaxCodeDriver } from '../data/build/dist/host/cli-adapters/mcode-driver.js'
import { ZcodeAppServerDriver } from '../data/build/dist/host/cli-adapters/zcode-driver.js'
import {
  attachmentMimeType, buildAcpPromptBlocks, buildClaudeUserContent, buildKimiUserInput,
  buildOpenCodeAttachmentParts, buildPiImages, prepareAttachmentPaths, withAttachmentPaths,
} from '../data/build/dist/host/cli-adapters/attachment-utils.js'
import type { CodingNsAgentEvent, CodingNsCliAttachment, CodingNsCliTurnInput } from '../data/build/dist/shared/contracts/cli-adapter.js'

// 一张真实的 1×1 PNG；路径模拟 DSH 内容寻址对象，不携带扩展名。
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh1sAAAAASUVORK5CYII=', 'base64')
const detection = () => ({ status: 0, stdout: 'fake-agent 1.2.3', stderr: '' }) as never

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'codingns-image-regression-'))
  const path = join(root, '42e1a977e447f19b9123260c4f17cbb8572bd4ca7847328eb12d7cf0e051c294')
  writeFileSync(path, PNG)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const input: CodingNsCliTurnInput = { sessionId: 'image-regression', messages: [], prompt: '查看图片', cwd: root, attachments: [{ kind: 'image', path }] }
  return { root, path, input }
}

function readableImagePath(prompt: string): string {
  const path = prompt.match(/@([^\n]+\.png)(?:\n|$)/u)?.[1]
  assert.ok(path, 'Provider 必须收到真实存在且带 .png 后缀的路径')
  assert.deepEqual(readFileSync(path), PNG)
  return path
}

async function collect(stream: AsyncIterable<CodingNsAgentEvent>): Promise<CodingNsAgentEvent[]> {
  const events: CodingNsAgentEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

test('无后缀图片按内容补齐路径，保留原始对象、普通文件和正确的现有图片路径', async (t) => {
  const { root, path, input } = fixture(t)
  const filePath = join(root, 'notes.md')
  writeFileSync(filePath, '普通文件')
  const file: CodingNsCliAttachment = { kind: 'file', path: filePath, name: 'notes.md' }
  const prepared = await prepareAttachmentPaths({ ...input, attachments: [{ kind: 'image', path, name: 'wrong.jpg', mimeType: 'image/jpeg' }, file] })
  const image = prepared.input.attachments![0]!
  assert.equal(image.mimeType, 'image/png')
  assert.equal(image.name, 'wrong.png')
  assert.match(image.path, /\.png$/u)
  assert.deepEqual(readFileSync(image.path), PNG)
  assert.equal(prepared.input.attachments![1], file)
  prepared.cleanup()
  prepared.cleanup()
  assert.equal(existsSync(dirname(image.path)), false)
  assert.deepEqual(readFileSync(path), PNG)
  const existingPath = join(root, 'existing.PNG')
  writeFileSync(existingPath, PNG)
  const existing = await prepareAttachmentPaths({ ...input, attachments: [{ kind: 'image', path: existingPath }] })
  assert.equal(existing.input.attachments![0]!.path, existingPath)
  existing.cleanup()
  assert.equal(existsSync(existingPath), true)
})

test('所有原生图片构造器识别无后缀、缺 MIME 的图片并保留完整二进制内容', async (t) => {
  const { input } = fixture(t)
  const attachments = input.attachments!
  assert.equal(attachmentMimeType({ ...attachments[0]!, name: 'image.png' }), 'image/png')
  assert.equal(attachmentMimeType({ ...attachments[0]!, mimeType: 'image/jpg; charset=binary' }), 'image/jpeg')
  assert.deepEqual(await buildAcpPromptBlocks('', attachments), [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }])
  assert.deepEqual(await buildPiImages(attachments), [{ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }])
  const parts = await buildOpenCodeAttachmentParts(attachments)
  assert.match(String(parts[0]?.filename), /\.png$/u)
  assert.equal(parts[0]?.url, `data:image/png;base64,${PNG.toString('base64')}`)
  assert.deepEqual(await buildClaudeUserContent('', attachments), [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }])
  assert.deepEqual(await buildKimiUserInput('', attachments), [{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }])
})

test('无后缀 GIF 和 WebP 不再被限制在 PNG/JPEG 的副本分支', async (t) => {
  const { path, input } = fixture(t)
  for (const [extension, bytes] of [['.gif', Buffer.from('GIF89a图片')], ['.webp', Buffer.from('RIFF0000WEBP图片')]] as const) {
    writeFileSync(path, bytes)
    const prepared = await prepareAttachmentPaths(input)
    const image = prepared.input.attachments![0]!
    assert.ok(image.path.endsWith(extension))
    assert.deepEqual(readFileSync(image.path), bytes)
    prepared.cleanup()
    assert.equal(existsSync(image.path), false)
  }
})

test('同一原始图片的并发回合使用独立副本，关闭或异常退出只清理自己的文件', async (t) => {
  const { input } = fixture(t)
  let firstPath = ''
  let secondPath = ''
  const first = withAttachmentPaths(input, async function* (prepared) {
    firstPath = prepared.attachments![0]!.path
    yield { type: 'text-delta', text: '第一段' }
    throw new Error('Provider 失败')
  })
  const second = withAttachmentPaths(input, async function* (prepared) {
    secondPath = prepared.attachments![0]!.path
    yield { type: 'text-delta', text: '第二回合' }
  })
  await first.next()
  await second.next()
  assert.notEqual(firstPath, secondPath)
  assert.equal(existsSync(firstPath), true)
  await second.return(undefined)
  assert.equal(existsSync(secondPath), false)
  assert.equal(existsSync(firstPath), true)
  await assert.rejects(first.next(), /Provider 失败/u)
  assert.equal(existsSync(firstPath), false)
})

test('无法识别的无后缀图片在派发前明确失败，不发送 application/octet-stream 图片块', async (t) => {
  const { path, input } = fixture(t)
  writeFileSync(path, Buffer.from([0, 1, 2, 3]))
  await assert.rejects(prepareAttachmentPaths(input), /无法识别图片附件/u)
  await assert.rejects(buildAcpPromptBlocks('', input.attachments!), /无法识别图片附件/u)
  assert.equal(existsSync(path), true)
})

test('Antigravity 和 Gemini 旧协议实际收到带后缀图片及可访问目录，结束后清理副本', async (t) => {
  const { input, path } = fixture(t)
  for (const kind of ['antigravity', 'gemini'] as const) {
    let imagePath = ''
    const spawn = ((_command: string, args: string[]) => {
      if (args.includes('--experimental-acp')) throw new Error('旧 CLI 不支持 ACP')
      if (kind === 'gemini') {
        imagePath = readableImagePath(args[args.indexOf('-p') + 1]!)
        assert.ok(args.includes(dirname(imagePath)))
      }
      const stdin = new PassThrough()
      stdin.on('data', (line) => {
        imagePath = readableImagePath(JSON.parse(String(line)).message.content)
        assert.ok(args.includes(dirname(imagePath)))
      })
      return { stdin, stdout: Readable.from([`${JSON.stringify(kind === 'gemini' ? { type: 'result', status: 'success' } : { event: 'result', result: {} })}\n`]), stderr: new PassThrough(), kill() { return true } }
    }) as never
    const driver = kind === 'gemini'
      ? new GeminiCliDriver({ binaries: ['fake-gemini'], spawnSync: detection, spawn })
      : new AntigravityDriver({ binaries: ['fake-agy'], spawnSync: detection, spawn, resolveContextWindow: () => undefined, resolveModelId: () => null })
    t.after(() => driver.dispose())
    const events = await collect(driver.executeTurn(input))
    assert.equal(events.at(-1)?.type, 'finish')
    assert.equal(existsSync(imagePath), false)
    assert.deepEqual(readFileSync(path), PNG)
  }
})

test('ZCode session/send 不再暴露无后缀对象路径，连续回合各自回收副本', { timeout: 5_000 }, async (t) => {
  const { input, path } = fixture(t)
  const imagePaths: string[] = []
  const driver = new ZcodeAppServerDriver({ binaries: ['fake-zcode'], spawnSync: detection, spawn: (() => {
    const stdout = new PassThrough(); const stderr = new PassThrough()
    const reply = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`)
    return { stdout, stderr, stdin: { write(line: string) {
      const request = JSON.parse(line)
      if (request.method === 'session/send') {
        imagePaths.push(readableImagePath(request.params.content))
        assert.equal(request.params.content.includes(path), false)
        reply({ id: request.id, result: {} })
        reply({ method: 'state.updated', params: { reason: 'prompt_started', patch: { status: 'running' } } })
        reply({ method: 'message.delta', params: { delta: '看到了图片' } })
        reply({ method: 'state.updated', params: { patch: { status: 'idle' } } })
      } else reply({ id: request.id, result: request.method === 'session/create' ? { session: { sessionId: 'zcode-images' } } : {} })
    } }, kill() { stdout.end(); stderr.end(); return true } }
  }) as never })
  t.after(() => driver.dispose())
  for (let turn = 0; turn < 2; turn++) {
    const events = await collect(driver.executeTurn(input))
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'stop' })
    assert.equal(existsSync(imagePaths[turn]!), false)
  }
  assert.notEqual(imagePaths[0], imagePaths[1])
  assert.deepEqual(readFileSync(path), PNG)
})

test('MiniMax 显式思考档位 exec 路径使用带后缀副本，ACP 路径保留内联图片', async (t) => {
  const { input } = fixture(t)
  let imagePath = ''
  let prompt: unknown
  const driver = new MiniMaxCodeDriver({ binaries: ['fake-mcode'], spawnSync: detection, spawn: ((_command: string, args: string[]) => {
    if (args[0] === 'exec') {
      const stdin = new PassThrough()
      stdin.on('data', (line) => { imagePath = readableImagePath(String(line)) })
      return { stdin, stdout: Readable.from(['{"type":"exec.completed","result":{"status":"succeeded"}}\n']), stderr: new PassThrough(), kill() { return true } }
    }
    const stdout = new PassThrough(); const stderr = new PassThrough()
    return { stdout, stderr, stdin: { write(line: string) {
      const request = JSON.parse(line)
      if (request.id === undefined) return
      if (request.method === 'session/prompt') prompt = request.params.prompt
      const result = request.method === 'session/new' ? { sessionId: 'mcode-images' } : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
    } }, kill() { stdout.end(); stderr.end(); return true } }
  }) as never })
  // 隔离真实用户的模型配置，以官方目录形状声明可用档位。
  Object.assign(driver, { mcodeCatalog: { groups: [{ id: 'test', name: '测试', models: [{ id: 'model', name: '模型', efforts: ['high'] }] }], currentModel: 'model', currentEffort: null } })
  t.after(() => driver.dispose())
  await collect(driver.executeTurn({ ...input, modelId: 'model', effortId: 'high' }))
  assert.equal(existsSync(imagePath), false)
  await collect(driver.executeTurn(input))
  assert.deepEqual(prompt, [{ type: 'text', text: '查看图片' }, { type: 'image', mimeType: 'image/png', data: PNG.toString('base64') }])
})

test('Command Code 图片副本跨分段续跑持续可读，终态和丢弃均清理', async (t) => {
  const { input, root, path } = fixture(t)
  const event = (value: unknown) => `${JSON.stringify({ type: 'event', event: value })}\n`
  let imagePath = ''
  let spawnCount = 0
  const driver = new CommandCodeDriver({ homeDirectory: root, binaries: ['fake-command'], spawnSync: detection, spawn: ((_command: string, args: string[]) => {
    spawnCount++
    imagePath = readableImagePath(args[args.indexOf('-p') + 1]!)
    assert.ok(args.includes(dirname(imagePath)))
    return { stdout: Readable.from([
      event({ type: 'message_start' }), event({ type: 'text_delta', delta: '先查看' }),
      event({ type: 'tool_completed', toolCallId: 'read', toolName: 'read', result: '图片' }),
      event({ type: 'message_start' }), event({ type: 'text_delta', delta: '完成' }),
      '{"type":"result","subtype":"success","finalText":"完成"}\n',
    ]), stderr: new PassThrough(), kill() { return true } }
  }) as never })
  t.after(() => driver.dispose())
  const first = await collect(driver.executeTurn({ ...input, splitToolSteps: true }))
  assert.equal(first.at(-1)?.type, 'step-boundary')
  assert.deepEqual(readFileSync(imagePath), PNG)
  const final = await collect(driver.executeTurn({ ...input, attachments: [], splitToolSteps: true, resumeSegmentedTurn: true }))
  assert.equal(final.at(-1)?.type, 'finish')
  assert.equal(spawnCount, 1)
  assert.equal(existsSync(imagePath), false)
  await collect(driver.executeTurn({ ...input, sessionId: 'discard-image-turn', splitToolSteps: true }))
  assert.equal(existsSync(imagePath), true)
  driver.discardSegmentedTurn('discard-image-turn')
  assert.equal(existsSync(imagePath), false)
  assert.deepEqual(readFileSync(path), PNG)
})

test('Kimi wire 图片进入真实 user_input 内容块，旧协议回退仍发送可读取图片路径', async (t) => {
  const { input } = fixture(t)
  for (const fallback of [false, true]) {
    let params: Record<string, unknown> | undefined
    let imagePath = ''
    const driver = new KimiCliDriver({ binaries: ['fake-kimi'], spawnSync: detection, spawn: ((_command: string, args: string[]) => {
      if (fallback && args.includes('--wire')) throw new Error('旧 CLI 不支持 wire')
      if (fallback) {
        const stdin = new PassThrough()
        stdin.on('data', (line) => { imagePath = readableImagePath(JSON.parse(String(line)).content[0].text) })
        return { stdin, stdout: Readable.from(['{"type":"result"}\n']), stderr: new PassThrough(), kill() { return true } }
      }
      const stdout = new PassThrough(); const stderr = new PassThrough()
      return { stdout, stderr, stdin: { write(line: string) {
        const request = JSON.parse(line)
        if (request.method === 'prompt') params = request.params
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'prompt' ? { status: 'finished' } : {} })}\n`)
      } }, kill() { stdout.end(); stderr.end(); return true } }
    }) as never })
    t.after(() => driver.dispose())
    await collect(driver.executeTurn(input))
    if (fallback) assert.equal(existsSync(imagePath), false)
    else assert.deepEqual(params, { user_input: [{ type: 'text', text: '查看图片' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` } }] })
  }
})

test('取消文本 Provider 时回收图片副本，原始对象不受影响', async (t) => {
  const { input, path } = fixture(t)
  const controller = new AbortController()
  let imagePath = ''
  const driver = new AntigravityDriver({ binaries: ['fake-agy'], spawnSync: detection, resolveContextWindow: () => undefined, resolveModelId: () => null, spawn: (() => {
    const stdout = new PassThrough(); const stderr = new PassThrough(); const stdin = new PassThrough()
    stdin.on('data', (line) => {
      imagePath = readableImagePath(JSON.parse(String(line)).message.content)
      controller.abort()
    })
    return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
  }) as never })
  t.after(() => driver.dispose())
  const events = await collect(driver.executeTurn({ ...input, signal: controller.signal }))
  assert.deepEqual(events.at(-1), { type: 'finish', reason: 'cancel' })
  assert.equal(existsSync(imagePath), false)
  assert.deepEqual(readFileSync(path), PNG)
})
