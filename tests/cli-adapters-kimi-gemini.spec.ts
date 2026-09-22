import assert from 'node:assert/strict'
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
            stdout.write(JSON.stringify({ type: 'tool_call', tool_name: 'shell' }) + '\n')
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
    { type: 'tool-running', toolName: 'shell' },
    { type: 'usage', inputTokens: 2, outputTokens: 3 },
    { type: 'finish', reason: 'stop' },
  ])
})

test('Gemini ACP 完成初始化、session/new、prompt 并转换更新事件', async () => {
  const calls: string[][] = []
  const driver = new GeminiCliDriver({
    binaries: ['fake-gemini'], spawnSync: fakeDetection,
    spawn: ((command: string, args: string[]) => {
      calls.push([command, ...args])
      const stdout = new PassThrough(); const stderr = new PassThrough()
      let nextId = 0
      const stdin = { write(data: string): boolean {
        const request = JSON.parse(data) as { id?: number; method?: string }
        if (request.id === undefined) return true
        const result = request.method === 'session/new' ? { sessionId: 'gemini-session-1' } : {}
        if (request.method === 'session/prompt') {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP 回复' } } } }) + '\n')
          stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'turn_completed' } } }) + '\n')
        }
        queueMicrotask(() => stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result, ...(nextId++ < 0 ? { nope: true } : {}) }) + '\n'))
        return true
      } }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  const chunks: unknown[] = []
  for await (const chunk of driver.executeTurn({ sessionId: 's1', messages: [], prompt: '你好' })) chunks.push(chunk)
  assert.deepEqual(calls[0], ['fake-gemini', '--experimental-acp'])
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'gemini-session-1' },
    { type: 'text-delta', text: 'ACP 回复' },
    { type: 'finish', reason: 'stop' },
  ])
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
  assert.deepEqual(catalog.groups[0]?.models.map((model) => model.id), ['auto-gemini-2.5', 'gemini-2.5-pro'])
  assert.equal(catalog.groups[0]?.models.some((model) => model.id.toLowerCase() === 'model'), false)
  assert.equal(catalog.currentModel, 'auto-gemini-2.5')
})
