import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { CodeBuddyCliDriver, WorkBuddyCliDriver } from '../data/build/dist/host/cli-adapters/codebuddy-driver.js'

function detected() {
  return { status: 0, stdout: 'codebuddy 2.159.0', stderr: '' } as never
}

test('CodeBuddy 与 WorkBuddy 使用不同配置根，WorkBuddy 不回退 PATH', async () => {
  const codebuddy = new CodeBuddyCliDriver({
    binaries: ['fake-codebuddy'],
    environment: { CODEBUDDY_CONFIG_DIR: '/tmp/codebuddy-root' },
    spawnSync: detected,
  })
  assert.equal(codebuddy.configDirectory, '/tmp/codebuddy-root')
  assert.deepEqual(await codebuddy.detect(), { installed: true, version: '2.159.0', command: 'fake-codebuddy' })

  const calls: string[] = []
  const workbuddy = new WorkBuddyCliDriver({
    commandPath: '/tmp/missing-workbuddy-codebuddy',
    spawnSync: ((command: string) => {
      calls.push(command)
      return { status: 127, stdout: '', stderr: '' }
    }) as never,
    platform: 'darwin',
  })
  assert.deepEqual(await workbuddy.detect(), { installed: false, version: null, command: null })
  assert.deepEqual(calls, ['/tmp/missing-workbuddy-codebuddy'])
  assert.equal(workbuddy.supportsToolStepSplitting, true)
})

test('CodeBuddy ACP 将会话、正文、思考和工具事件收敛到公共流', async () => {
  const driver = new CodeBuddyCliDriver({
    binaries: ['fake-codebuddy'],
    spawnSync: detected,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = {
        write(data: string): boolean {
          const request = JSON.parse(data) as { id?: number; method?: string }
          if (request.method === 'session/new') {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'codebuddy-session' } })}\n`)
          }
          if (request.method === 'session/prompt') {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', text: '检查' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'bash', status: 'running', rawInput: { command: 'pwd' } } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'bash', status: 'completed', rawOutput: '/work' } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成后' } } } })}\n`)
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } })}\n`)
          }
          if (request.method === 'initialize') stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`)
          return true
        },
      }
      return { stdout, stderr, stdin, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  assert.equal(driver.supportsToolStepSplitting, true)
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'dsh-session', messages: [], prompt: '检查' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'session-binding', providerSessionId: 'codebuddy-session' },
    { type: 'text-delta', text: '完成', messageId: 'assistant-codebuddy-dsh-session-0' },
    { type: 'reasoning-delta', text: '检查', messageId: 'assistant-codebuddy-dsh-session-0' },
    { type: 'tool-event', toolName: 'bash', callId: 'call-1', input: '{"command":"pwd"}', status: 'running' },
    { type: 'tool-event', toolName: 'bash', callId: 'call-1', output: '/work', outputMode: 'snapshot', status: 'completed' },
    { type: 'text-delta', text: '完成后', messageId: 'assistant-codebuddy-dsh-session-1' },
    { type: 'finish', reason: 'stop' },
  ])
  assert.equal(driver.descriptor.capabilities.includes('permission'), false)
  assert.equal(driver.descriptor.capabilities.includes('questions'), false)
  driver.dispose()
})
