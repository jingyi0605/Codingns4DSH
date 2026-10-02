import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { CursorCliDriver } from '../data/build/dist/host/cli-adapters/cursor-driver.js'
import { KiroCliDriver } from '../data/build/dist/host/cli-adapters/kiro-driver.js'

function fakeDetection() { return ({ status: 0, stdout: 'agent 1.2.3', stderr: '' }) as never }

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
