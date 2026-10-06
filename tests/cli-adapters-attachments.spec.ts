import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { PassThrough, Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'
import { CommandCodeDriver } from '../data/build/dist/host/cli-adapters/command-code-driver.js'
import { GeminiCliDriver } from '../data/build/dist/host/cli-adapters/gemini-driver.js'
import { GrokBuildDriver } from '../data/build/dist/host/cli-adapters/grok-driver.js'
import { KimiCliDriver } from '../data/build/dist/host/cli-adapters/kimi-driver.js'
import { OpenCodeDriver } from '../data/build/dist/host/cli-adapters/opencode-driver.js'
import { PiAgentDriver } from '../data/build/dist/host/cli-adapters/pi-driver.js'
import { buildAcpPromptBlocks } from '../data/build/dist/host/cli-adapters/attachment-utils.js'

const detection = () => ({ status: 0, stdout: 'fake-agent 1.2.3', stderr: '' }) as never

test('文本 CLI 适配器把附件路径和可访问目录传给 Provider', () => {
  const input = {
    sessionId: 'text-attachments',
    messages: [],
    prompt: '请检查附件',
    attachments: [
      { kind: 'image' as const, path: '/tmp/codingns-attachments/photo.png', name: 'photo.png', mimeType: 'image/png' },
      { kind: 'file' as const, path: '/tmp/codingns-attachments/readme.md', name: 'readme.md', mimeType: 'text/markdown' },
    ],
  }
  const expectedPrompt = '请检查附件\n请读取并处理以下消息附件：\n附件「photo.png」：@/tmp/codingns-attachments/photo.png\n附件「readme.md」：@/tmp/codingns-attachments/readme.md'

  const claudeArgs = (new ClaudeCodeDriver({ binaries: ['fake-claude'] }) as unknown as { buildArgs(value: typeof input): readonly string[] }).buildArgs(input)
  assert.equal(claudeArgs.includes('--print'), true)
  assert.equal(claudeArgs.includes('-p'), false)
  assert.equal(claudeArgs.includes(expectedPrompt), false)
  assert.deepEqual(claudeArgs.slice(-2), ['--add-dir', '/tmp/codingns-attachments'])

  const geminiArgs = (new GeminiCliDriver({ binaries: ['fake-gemini'] }) as unknown as { buildArgs(value: typeof input): readonly string[] }).buildArgs(input)
  assert.equal(geminiArgs[1], expectedPrompt)
  assert.deepEqual(geminiArgs.slice(-2), ['--include-directories', '/tmp/codingns-attachments'])
})

test('Claude Code 为无扩展名图片建立受支持后缀的临时路径并在回合结束清理', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-image-'))
  const imagePath = join(root, '1588ddd5b29f1b5a0e43492ea636c5f79bff288357d2c17f928f008822a9bab7')
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  writeFileSync(imagePath, imageBytes)
  let receivedArgs: string[] = []
  let preparedPath: string | undefined
  let preparedPrompt = ''
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      spawnSync: detection,
      spawn: ((_command: string, args: string[]) => {
        receivedArgs = args
        const stdin = new PassThrough()
        stdin.on('data', (chunk) => {
          const message = JSON.parse(String(chunk)) as { type?: unknown; message?: { content?: Array<{ text?: unknown }> } }
          if (message.type !== 'user') return
          preparedPrompt = typeof message.message?.content?.[0]?.text === 'string' ? message.message.content[0].text : ''
          preparedPath = preparedPrompt.match(/@([^\n]+)$/u)?.[1]
          assert.ok(preparedPath?.endsWith('.png'))
          assert.deepEqual(readFileSync(preparedPath!), imageBytes)
        })
        return {
          stdout: Readable.from([`${JSON.stringify({ type: 'result' })}\n`]),
          stderr: { on() { return this } },
          stdin,
          kill() { return true },
        }
      }) as never,
    })
    for await (const _chunk of driver.executeTurn({
      sessionId: 'claude-image-attachments', messages: [], prompt: '请查看截图',
      attachments: [{ kind: 'image', path: imagePath }],
    })) { /* 检查发送参数和临时文件生命周期。 */ }
    assert.match(preparedPrompt, /附件「attachment-0\.png」：@[^\n]+\.png$/u)
    assert.equal(existsSync(preparedPath!), false)
    const addDirIndex = receivedArgs.lastIndexOf('--add-dir')
    assert.equal(receivedArgs[addDirIndex + 1], dirname(preparedPath!))
    driver.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Command Code 把附件路径写入 prompt 并开放附件目录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-command-code-'))
  const imagePath = join(root, 'photo.png')
  const filePath = join(root, 'readme.md')
  writeFileSync(imagePath, Buffer.from([1, 2, 3]))
  writeFileSync(filePath, '附件内容')
  let receivedArgs: string[] = []
  const driver = new CommandCodeDriver({
    binaries: ['fake-command-code'],
    spawnSync: detection,
    spawn: ((_command: string, args: string[]) => {
      receivedArgs = args
      return {
        stdout: Readable.from([`${JSON.stringify({ type: 'result', subtype: 'success', finalText: '完成' })}\n`]),
        stderr: { on() { return this } },
        kill() { return true },
      }
    }) as never,
  })
  try {
    for await (const _chunk of driver.executeTurn({
      sessionId: 'command-code-attachments',
      messages: [],
      prompt: '请检查附件',
      attachments: [
        { kind: 'image', path: imagePath, name: 'photo.png' },
        { kind: 'file', path: filePath, name: 'readme.md' },
      ],
    })) { /* 只检查发送参数。 */ }
    const promptIndex = receivedArgs.indexOf('-p')
    assert.equal(receivedArgs[promptIndex + 1], `请检查附件\n请读取并处理以下消息附件：\n附件「photo.png」：@${imagePath}\n附件「readme.md」：@${filePath}`)
    assert.deepEqual(receivedArgs.slice(-2), ['--add-dir', root])
  } finally {
    driver.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Kimi wire 传递附件元数据并保留路径提示', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-kimi-'))
  const filePath = join(root, 'notes.txt')
  writeFileSync(filePath, 'Kimi 附件')
  let promptParams: Record<string, unknown> | undefined
  const driver = new KimiCliDriver({
    binaries: ['fake-kimi'],
    spawnSync: detection,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id: string; method: string }
        if (request.method === 'initialize') {
          queueMicrotask(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`))
        } else if (request.method === 'prompt') {
          promptParams = (JSON.parse(data) as { params: Record<string, unknown> }).params
          queueMicrotask(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { status: 'finished' } })}\n`))
        }
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  try {
    for await (const _chunk of driver.executeTurn({
      sessionId: 'kimi-attachments', messages: [], prompt: '读取附件',
      attachments: [{ kind: 'file', path: filePath, name: 'notes.txt', mimeType: 'text/plain' }],
    })) { /* 只检查 wire 请求。 */ }
    assert.equal(promptParams?.user_input, `读取附件\n请读取并处理以下消息附件：\n附件「notes.txt」：@${filePath}`)
    assert.deepEqual(promptParams?.attachments, [{ file_path: filePath, file_name: 'notes.txt', mime_type: 'text/plain', file_size: Buffer.byteLength('Kimi 附件') }])
  } finally {
    driver.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('ACP 附件块内联图片并以 file URI 暴露普通文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-acp-'))
  const imagePath = join(root, 'photo.png')
  const filePath = join(root, 'report.pdf')
  writeFileSync(imagePath, Buffer.from([0xde, 0xad, 0xbe, 0xef]))
  writeFileSync(filePath, 'PDF placeholder')
  try {
    assert.deepEqual(await buildAcpPromptBlocks('查看附件', [
      { kind: 'image', path: imagePath, name: 'photo.png', mimeType: 'image/png' },
      { kind: 'file', path: filePath, name: 'report.pdf', mimeType: 'application/pdf' },
    ]), [
      { type: 'text', text: '查看附件' },
      { type: 'image', data: Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64'), mimeType: 'image/png' },
      { type: 'resource_link', uri: `file://${filePath}`, name: 'report.pdf', mimeType: 'application/pdf', size: 15 },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Gemini ACP 将附件块传递到 session/prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-gemini-'))
  const filePath = join(root, 'report.txt')
  writeFileSync(filePath, 'Gemini 文件')
  let prompt: unknown
  const driver = new GeminiCliDriver({
    binaries: ['fake-gemini'], spawnSync: detection,
    spawn: (() => {
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> }
        if (request.method === 'session/prompt') prompt = request.params?.prompt
        const result = request.method === 'session/new'
          ? { sessionId: 'gemini-attachments' }
          : request.method === 'session/prompt'
            ? { stopReason: 'end_turn' }
            : {}
        queueMicrotask(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`))
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  try {
    for await (const _chunk of driver.executeTurn({
      sessionId: 'gemini-attachments', messages: [], prompt: '读取',
      attachments: [{ kind: 'file', path: filePath, name: 'report.txt', mimeType: 'text/plain' }],
    })) { /* 只检查 ACP 请求。 */ }
    assert.deepEqual(prompt, [
      { type: 'text', text: '读取' },
      { type: 'resource_link', uri: `file://${filePath}`, name: 'report.txt', mimeType: 'text/plain', size: Buffer.byteLength('Gemini 文件') },
    ])
  } finally {
    driver.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Grok ACP 将完整附件块数组直接发给 session/prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-grok-'))
  const imagePath = join(root, 'photo.png')
  writeFileSync(imagePath, Buffer.from([7, 8, 9]))
  let prompt: unknown
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'], spawnSync: detection,
    spawn: (() => {
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; method: string; params?: Record<string, unknown> }
        if (request.method === 'session/new') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'grok-attachments' } })}\n`)
        } else if (request.method === 'session/prompt') {
          prompt = request.params?.prompt
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'turn_completed' } } })}\n`)
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
        } else if (request.id !== undefined) {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  try {
    for await (const _chunk of driver.executeTurn({
      sessionId: 'grok-attachments', messages: [], prompt: '看图',
      attachments: [{ kind: 'image', path: imagePath, name: 'photo.png', mimeType: 'image/png' }],
    })) { /* 只检查 ACP 请求。 */ }
    assert.deepEqual(prompt, [
      { type: 'text', text: '看图' },
      { type: 'image', data: Buffer.from([7, 8, 9]).toString('base64'), mimeType: 'image/png' },
    ])
  } finally {
    driver.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Pi RPC 将图片以内联 base64 images 传递并提示普通路径', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-pi-'))
  const imagePath = join(root, 'photo.jpg')
  const filePath = join(root, 'notes.md')
  writeFileSync(imagePath, Buffer.from([10, 11, 12]))
  writeFileSync(filePath, 'Pi 文件')
  let promptRequest: Record<string, unknown> | undefined
  const driver = new PiAgentDriver({
    binaries: ['fake-pi'], spawnSync: detection,
    spawn: (() => {
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): void {
        const request = JSON.parse(data) as { id: number; type?: string }
        if (request.type === 'prompt') {
          promptRequest = request as unknown as Record<string, unknown>
          stdout.write(`${JSON.stringify({ id: request.id, type: 'response', success: true, data: {} })}\n`)
          setImmediate(() => stdout.write(`${JSON.stringify({ type: 'agent_settled' })}\n`))
        } else {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        }
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  try {
    for await (const _chunk of driver.executeTurn({
      sessionId: 'pi-attachments', messages: [], prompt: '处理文件',
      attachments: [
        { kind: 'image', path: imagePath, name: 'photo.jpg', mimeType: 'image/jpeg' },
        { kind: 'file', path: filePath, name: 'notes.md', mimeType: 'text/markdown' },
      ],
    })) { /* 只检查 RPC 请求。 */ }
    assert.equal(promptRequest?.message, `处理文件\n请读取并处理以下消息附件：\n附件「photo.jpg」：@${imagePath}\n附件「notes.md」：@${filePath}`)
    assert.deepEqual(promptRequest?.images, [{ type: 'image', data: Buffer.from([10, 11, 12]).toString('base64'), mimeType: 'image/jpeg' }])
  } finally {
    driver.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('OpenCode message 使用 data URL file part 传递图片和文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-opencode-'))
  const imagePath = join(root, 'photo.png')
  const filePath = join(root, 'notes.txt')
  writeFileSync(imagePath, Buffer.from([13, 14]))
  writeFileSync(filePath, 'OpenCode 文件')
  const requests: Record<string, unknown>[] = []
  const encoder = new TextEncoder()
  const driver = new OpenCodeDriver({
    fetch: async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/global/health')) return new Response('{}', { status: 200 })
      if (url.endsWith('/session') && init.method === 'POST') return new Response(JSON.stringify({ id: 'opencode-attachments' }), { status: 200 })
      if (url.endsWith('/message')) { requests.push(JSON.parse(String(init.body)) as Record<string, unknown>); return new Response('{}', { status: 200 }) }
      if (url.endsWith('/event')) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
        const body = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"session.status","status":"idle"}\n\n'))
          controller.close()
        } })
        return new Response(body, { status: 200 })
      }
      return new Response('{}', { status: 404 })
    },
    serverUrls: ['http://opencode.test'], binaries: [],
  })
  try {
    for await (const _chunk of driver.executeTurn({
      sessionId: 'opencode-attachments', messages: [], prompt: '读取',
      attachments: [
        { kind: 'image', path: imagePath, name: 'photo.png', mimeType: 'image/png' },
        { kind: 'file', path: filePath, name: 'notes.txt', mimeType: 'text/plain' },
      ],
    })) { /* 只检查 HTTP 请求。 */ }
    assert.equal(requests.length, 1)
    const parts = requests[0]?.parts as Record<string, unknown>[]
    assert.deepEqual(parts, [
      { type: 'text', text: '读取' },
      { type: 'file', mime: 'image/png', filename: 'photo.png', url: `data:image/png;base64,${Buffer.from([13, 14]).toString('base64')}` },
      { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: `data:text/plain;base64,${Buffer.from('OpenCode 文件').toString('base64')}` },
    ])
  } finally {
    driver.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
