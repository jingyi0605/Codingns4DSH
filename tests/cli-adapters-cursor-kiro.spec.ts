import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { CursorCliDriver, parseCursorModelList } from '../data/build/dist/host/cli-adapters/cursor-driver.js'
import { KiroCliDriver } from '../data/build/dist/host/cli-adapters/kiro-driver.js'

function fakeDetection() { return ({ status: 0, stdout: 'agent 1.2.3', stderr: '' }) as never }

test('Cursor CLI 从 --list-models 目录读取真实模型 id', () => {
  const catalog = parseCursorModelList([
    'Available models',
    '',
    'auto - Auto (current, default)',
    'gpt-5.5-high - GPT-5.5 1M High',
    'claude-sonnet-5-thinking-xhigh - Claude Sonnet 5 1M Extra High Thinking',
  ].join('\n'))
  assert.deepEqual(catalog.groups[0]?.models, [
    { id: 'auto', name: 'Auto (current, default)', efforts: [] },
    { id: 'gpt-5.5-high', name: 'GPT-5.5 1M High', efforts: [] },
    { id: 'claude-sonnet-5-thinking-xhigh', name: 'Claude Sonnet 5 1M Extra High Thinking', efforts: [] },
  ])
})

test('Cursor CLI 子进程跳过 SSH 会话的钥匙串预检', async () => {
  const environments: Array<Record<string, string | undefined> | undefined> = []
  const driver = new CursorCliDriver({
    binaries: ['fake-cursor-agent'],
    spawnSync: ((command: string, args: readonly string[], options?: { env?: Record<string, string | undefined> }) => {
      environments.push(options?.env)
      if (args[0] === '--version') return { status: 0, stdout: 'agent 1.2.3', stderr: '' }
      return { status: 1, stdout: '', stderr: 'auth unavailable' }
    }) as never,
  })
  await driver.listModels()
  assert.equal(environments.some((environment) => environment?.CI === '1'), true)
  driver.dispose()
})

test('Cursor ACP 在启动参数中固定选中的模型，不发送不受支持的 session/set_model', async () => {
  const calls: string[][] = []
  const methods: string[] = []
  let spawnEnvironment: Record<string, string | undefined> | undefined
  const driver = new CursorCliDriver({
    binaries: ['fake-cursor-agent'],
    spawnSync: fakeDetection,
    spawn: ((command: string, args: string[], options?: { env?: Record<string, string | undefined> }) => {
      calls.push([command, ...args])
      spawnEnvironment = options?.env
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number; method?: string }
        if (request.method) methods.push(request.method)
        const result = request.method === 'session/new' ? { sessionId: 'cursor-model-session' } : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
        if (request.id !== undefined) stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'cursor-model-dsh', messages: [], prompt: '执行', modelId: 'gpt-5.5-high' })) chunks.push(chunk)
  assert.deepEqual(calls[0], ['fake-cursor-agent', '--model', 'gpt-5.5-high', 'acp'])
  assert.equal(spawnEnvironment?.CI, '1')
  assert.equal(methods.includes('session/set_model'), false)
  assert.equal(chunks[0]?.type, 'session-binding')
  driver.dispose()
})

test('Cursor ACP 使用 cursor-agent acp，映射文本和工具事件且不伪造用量', async () => {
  const calls: string[][] = []
  const driver = new CursorCliDriver({
    binaries: ['fake-cursor-agent'],
    spawnSync: fakeDetection,
    spawn: ((command: string, args: string[]) => {
      calls.push([command, ...args])
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, any> }
        const result = request.method === 'session/new' ? { sessionId: 'cursor-session' } : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
        if (request.method === 'session/prompt') {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Cursor 完成' } } } }) + '\n')
          stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'tool_call', toolCallId: 'cursor-call', title: 'shell', status: 'running', rawInput: { command: 'pwd' } } } }) + '\n')
          stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'tool_call_update', toolCallId: 'cursor-call', status: 'completed', rawOutput: '/work' } } }) + '\n')
          stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'cursor-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Cursor 后续' } } } }) + '\n')
        }
        if (request.id !== undefined) stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  assert.equal(driver.supportsToolStepSplitting, true)
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'cursor-dsh', messages: [], prompt: '执行' })) chunks.push(chunk)
  assert.deepEqual(calls[0], ['fake-cursor-agent', 'acp'])
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'cursor-session' },
    { type: 'text-delta', text: 'Cursor 完成', messageId: 'assistant-cursor-cli-cursor-dsh-0' },
    { type: 'tool-event', toolName: 'shell', callId: 'cursor-call', input: '{"command":"pwd"}', status: 'running' },
    { type: 'tool-event', toolName: 'shell', callId: 'cursor-call', output: '/work', outputMode: 'snapshot', status: 'completed' },
    { type: 'text-delta', text: 'Cursor 后续', messageId: 'assistant-cursor-cli-cursor-dsh-1' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(driver.descriptor.capabilities.includes('usage'), false)
  driver.dispose()
})

test('通用 ACP 将 Cursor 权限请求交给 DSH 回传 Provider 选项', async () => {
  let promptId = 0
  let reply: Record<string, unknown> | undefined
  const driver = new CursorCliDriver({
    binaries: ['fake-cursor-agent'],
    spawnSync: fakeDetection,
    spawn: (() => {
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number | string; method?: string }
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'cursor-permission' } })}\n`)
        else if (request.method === 'session/prompt') {
          promptId = request.id ?? 0
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'session/request_permission', params: { options: [{ optionId: 'allow-custom', kind: 'allow_once' }, { optionId: 'deny-custom', kind: 'reject_once' }], toolCall: { title: 'shell', toolCallId: 'shell-1' }, detail: '运行 shell' } })}\n`)
        } else if (request.id === 77) {
          reply = request as unknown as Record<string, unknown>
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } })}\n`)
        }
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'cursor-permission-dsh', messages: [], prompt: '执行' })) {
    chunks.push(chunk)
    if (chunk.type === 'permission-request') driver.respondPermission('cursor-permission-dsh', { requestId: chunk.requestId, approved: true })
  }
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'cursor-permission' },
    { type: 'permission-request', requestId: '77', kind: 'shell', toolName: 'shell', callId: 'shell-1', detail: '运行 shell' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 77, result: { outcome: { outcome: 'selected', optionId: 'allow-custom' } } })
  driver.dispose()
})

test('通用 ACP 将 elicitation/create 映射为 DSH 问题并回传 form content', async () => {
  let promptId = 0
  let reply: Record<string, unknown> | undefined
  const driver = new CursorCliDriver({
    binaries: ['fake-cursor-agent'],
    spawnSync: fakeDetection,
    spawn: (() => {
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number | string; method?: string }
        if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
        else if (request.method === 'session/new') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'cursor-question' } })}\n`)
        else if (request.method === 'session/prompt') {
          promptId = request.id ?? 0
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 78, method: 'elicitation/create', params: { mode: 'form', message: '选择策略', requestedSchema: { type: 'object', properties: { strategy: { type: 'string', title: '策略', enum: ['safe', 'fast'] } } } } })}\n`)
        } else if (request.id === 78) {
          reply = request as unknown as Record<string, unknown>
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } })}\n`)
        }
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'cursor-question-dsh', messages: [], prompt: '执行' })) {
    chunks.push(chunk)
    if (chunk.type === 'question-request') driver.respondQuestion('cursor-question-dsh', {
      requestId: chunk.requestId,
      answers: [{ id: 'strategy', selected: ['safe'] }],
    })
  }
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'cursor-question' },
    { type: 'question-request', requestId: '78', questions: [{ id: 'strategy', question: '选择策略', header: '策略', options: [{ label: 'safe' }, { label: 'fast' }] }] },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 78, result: { action: 'accept', content: { strategy: 'safe' } } })
  driver.dispose()
})

test('Kiro ACP 固定 v3/cli 参数，会话探测不扫描猜测的 JSONL 存储', async () => {
  const calls: string[][] = []
  const driver = new KiroCliDriver({
    binaries: ['fake-kiro'],
    spawnSync: fakeDetection,
    spawn: ((command: string, args: string[]) => {
      calls.push([command, ...args])
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number; method?: string }
        const result = request.method === 'session/new' ? { sessionId: 'kiro-session' } : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
        if (request.id !== undefined) stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
  }) as never,
  })
  assert.equal(driver.supportsToolStepSplitting, true)
  assert.equal(driver.descriptor.capabilities.includes('permission'), true)
  assert.deepEqual(await driver.listModels(), { groups: [], currentModel: null, currentEffort: null })
  assert.deepEqual(calls, [])
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'kiro-dsh', messages: [], prompt: '执行' })) chunks.push(chunk)
  assert.deepEqual(calls[0], ['fake-kiro', 'acp', '--agent-engine', 'v3', '--auth-method', 'cli'])
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'kiro-session' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.deepEqual(await driver.probeSession({ providerSessionId: 'kiro-session' }), {
    state: 'unknown',
    reason: 'Kiro 会话存储为嵌套目录，尚未完成只读索引验证；未按 JSONL 规则猜测路径',
  })
  driver.dispose()
})
