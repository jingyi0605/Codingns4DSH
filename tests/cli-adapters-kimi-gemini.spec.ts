import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { GeminiCliDriver } from '../dist/host/cli-adapters/gemini-driver.js'
import { KimiCliDriver } from '../dist/host/cli-adapters/kimi-driver.js'

function fakeDetection() { return ({ status: 0, stdout: 'fake-agent 1.2.3', stderr: '' }) as never }

test('Kimi wire 优先并转换会话、思考、工具、用量和完成事件', async () => {
  const calls: string[][] = []
  const driver = new KimiCliDriver({
    binaries: ['fake-kimi'], spawnSync: fakeDetection,
    spawn: ((command: string, args: string[]) => {
      calls.push([command, ...args])
      const stdout = new PassThrough(); const stderr = new PassThrough(); let sent = false
      const stdin = { write(data: string): boolean {
        if (!sent) {
          sent = true
          const payload = JSON.parse(data) as Record<string, unknown>
          assert.equal(payload.type, 'prompt.submit')
          queueMicrotask(() => {
            stdout.write(JSON.stringify({ type: 'session.created', session_id: 'kimi-session-1' }) + '\n')
            stdout.write(JSON.stringify({ type: 'assistant.thinking', delta: '思考' }) + '\n')
            stdout.write(JSON.stringify({ type: 'assistant.message', content: [{ type: 'text', text: '回答' }] }) + '\n')
            stdout.write(JSON.stringify({ type: 'tool_call', tool_call: { id: 'kimi-call-1', name: 'shell', arguments: { command: 'pwd' } } }) + '\n')
            stdout.write(JSON.stringify({ type: 'tool_result', tool_result: { call_id: 'kimi-call-1', name: 'shell', output: '/workspace' } }) + '\n')
            stdout.write(JSON.stringify({ type: 'tool_failed', tool_result: { call_id: 'kimi-call-2', name: 'shell', error: 'exit 1' } }) + '\n')
            stdout.write(JSON.stringify({ type: 'tool_output_delta', tool_result: { call_id: 'kimi-call-3', name: 'shell', output: '片段', status: 'running' } }) + '\n')
            stdout.write(JSON.stringify({ type: 'usage', usage: { input_tokens: 2, output_tokens: 3 } }) + '\n')
            stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n')
          })
        }
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks: unknown[] = []
  for await (const chunk of driver.executeTurn({ sessionId: 's1', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(calls[0], ['fake-kimi', '--wire'])
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'kimi-session-1' },
    { type: 'reasoning-delta', text: '思考' },
    { type: 'text-delta', text: '回答' },
    { type: 'tool-running', toolName: 'shell', callId: 'kimi-call-1', input: '{"command":"pwd"}', status: 'running' },
    { type: 'tool-running', toolName: 'shell', callId: 'kimi-call-1', output: '/workspace', outputMode: 'snapshot', status: 'completed' },
    { type: 'tool-running', toolName: 'shell', callId: 'kimi-call-2', error: 'exit 1', status: 'failed' },
    { type: 'tool-running', toolName: 'shell', callId: 'kimi-call-3', output: '片段', outputMode: 'delta', status: 'running' },
    { type: 'usage', inputTokens: 2, outputTokens: 3 },
    { type: 'finish', reason: 'stop' },
  ])
})

test('Gemini ACP 完成初始化、session/new、prompt 并转换更新事件', async () => {
  const calls: string[][] = []
  const requests: Array<{ method?: string; params?: Record<string, unknown> }> = []
  let runtimeSettings: Record<string, any> | null = null
  const driver = new GeminiCliDriver({
    binaries: ['fake-gemini'], spawnSync: fakeDetection,
    spawn: ((command: string, args: string[], options: { env?: Record<string, string | undefined> }) => {
      calls.push([command, ...args])
      const settingsPath = options.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH ?? options.env?.GEMINI_CLI_SYSTEM_DEFAULTS_PATH
      if (settingsPath) runtimeSettings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, any>
      const stdout = new PassThrough(); const stderr = new PassThrough()
      let nextId = 0
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, unknown> }
        requests.push(request)
        if (request.id === undefined) return true
        const result = request.method === 'session/new'
          ? { sessionId: 'gemini-session-1' }
          : request.method === 'session/prompt'
            ? { stopReason: 'end_turn' }
            : {}
        if (request.method === 'session/prompt') {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP 回复' } } } }) + '\n')
          stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'gemini-call-1', title: 'read_file', status: 'running', rawInput: { path: 'a.ts' } } } }) + '\n')
          stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'gemini-call-1', title: 'read_file', status: 'completed', rawOutput: '源码' } } }) + '\n')
        }
        queueMicrotask(() => stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result, ...(nextId++ < 0 ? { nope: true } : {}) }) + '\n'))
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks: unknown[] = []
  for await (const chunk of driver.executeTurn({
    sessionId: 's1',
    messages: [],
    prompt: '你好',
    modelId: 'auto-gemini-3',
    effortId: 'medium',
  })) chunks.push(chunk)
  assert.deepEqual(calls[0], ['fake-gemini', '--experimental-acp'])
  assert.deepEqual(requests.find((request) => request.method === 'session/set_model')?.params, {
    sessionId: 'gemini-session-1',
    modelId: 'auto-gemini-3',
  })
  assert.equal('model' in (requests.find((request) => request.method === 'session/prompt')?.params ?? {}), false)
  const overrides = runtimeSettings?.modelConfigs?.customOverrides as Array<Record<string, any>> | undefined
  assert.deepEqual(overrides?.slice(-4).map((entry) => entry.match.model), [
    'gemini-3.1-pro-preview-customtools',
    'gemini-3.1-pro-preview',
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
  ])
  assert.deepEqual(overrides?.at(-1)?.modelConfig.generateContentConfig.thinkingConfig, { thinkingLevel: 'MEDIUM' })
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'gemini-session-1' },
    { type: 'text-delta', text: 'ACP 回复' },
    { type: 'tool-running', toolName: 'read_file', callId: 'gemini-call-1', input: '{"path":"a.ts"}', status: 'running' },
    { type: 'tool-running', toolName: 'read_file', callId: 'gemini-call-1', output: '源码', outputMode: 'snapshot', status: 'completed' },
    { type: 'finish', reason: 'stop' },
  ])
})

test('Gemini 按 ACP prompt stopReason 映射取消和错误终态', async () => {
  for (const [stopReason, expected] of [
    ['cancelled', 'cancel'],
    ['error', 'error'],
  ] as const) {
    const driver = new GeminiCliDriver({
      binaries: ['fake-gemini'],
      spawnSync: fakeDetection,
      spawn: (() => {
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const stdin = { write(data: string): boolean {
          const request = JSON.parse(data) as { id?: number; method?: string }
          if (request.id === undefined) return true
          const result = request.method === 'session/new'
            ? { sessionId: `gemini-${stopReason}` }
            : request.method === 'session/prompt'
              ? { stopReason }
              : {}
          queueMicrotask(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`))
          return true
        } }
        return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
      }) as never,
    })
    const chunks = []
    for await (const chunk of driver.executeTurn({ sessionId: `s-${stopReason}`, messages: [], prompt: '你好' })) chunks.push(chunk)
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: expected })
  }
})

test('Gemini 从 ACP session/new 读取真实模型目录而不是帮助参数占位符', async () => {
  const driver = new GeminiCliDriver({
    binaries: ['fake-gemini'],
    spawnSync: fakeDetection,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number; method?: string }
        if (request.id === undefined) return true
        const result = request.method === 'session/new'
          ? {
              sessionId: 'gemini-catalog-session',
              models: {
                currentModelId: 'auto-gemini-2.5',
                availableModels: [
                  { modelId: 'auto-gemini-2.5', name: 'Auto (Gemini 2.5)', description: '自动选择模型' },
                  { modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
                  { modelId: 'gemini-3-flash-preview', name: 'Gemini 3 Flash' },
                  { modelId: 'gemini-3-pro-preview', name: 'Gemini 3 Pro' },
                ],
              },
            }
          : {}
        queueMicrotask(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`))
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const catalog = await driver.listModels()
  assert.deepEqual(catalog.groups[0]?.models.map((model) => model.id), [
    'auto-gemini-2.5',
    'gemini-2.5-pro',
    'gemini-3-flash-preview',
    'gemini-3-pro-preview',
  ])
  assert.deepEqual(catalog.groups[0]?.models.map((model) => model.efforts), [
    ['low', 'medium', 'high'],
    ['low', 'medium', 'high'],
    ['minimal', 'low', 'medium', 'high'],
    ['low', 'high'],
  ])
  assert.equal(catalog.groups[0]?.models.some((model) => model.id.toLowerCase() === 'model'), false)
  assert.equal(catalog.currentModel, 'auto-gemini-2.5')
})
