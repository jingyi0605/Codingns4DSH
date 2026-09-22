import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { ClaudeCodeDriver } from '../dist/host/cli-adapters/claude-driver.js'
import { GeminiCliDriver } from '../dist/host/cli-adapters/gemini-driver.js'
import { KimiCliDriver } from '../dist/host/cli-adapters/kimi-driver.js'

test('Claude、Gemini、Kimi 的标准流驱动统一转换文本和完成事件', async () => {
  for (const [Driver, event] of [
    [ClaudeCodeDriver, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '完成' } } }],
    [GeminiCliDriver, { type: 'text_delta', delta: '完成' }],
    [KimiCliDriver, { type: 'text_delta', delta: '完成' }],
  ] as const) {
    const calls: string[][] = []
    let killed = false
    const driver = new Driver({
      binaries: ['fake-agent'],
      spawnSync: (() => ({ status: 0, stdout: 'fake-agent 1.2.3', stderr: '' })) as never,
      spawn: ((command: string, args: string[]) => {
        calls.push([command, ...args])
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        queueMicrotask(() => {
          stdout.write(`${JSON.stringify(event)}\n`)
          stdout.write(`${JSON.stringify({ type: 'result' })}\n`)
          stdout.end()
          stderr.end()
        })
        return { stdout, stderr, kill() { killed = true; return true } }
      }) as never,
    })
    const chunks = []
    for await (const chunk of driver.executeTurn({ sessionId: 's1', messages: [], prompt: '你好' })) chunks.push(chunk)
    assert.equal(calls[0]?.[0], 'fake-agent')
    assert.deepEqual(chunks.filter((chunk) => chunk.type !== 'session-binding'), [
      { type: 'text-delta', text: '完成' },
      { type: 'finish', reason: 'stop' },
    ])
    assert.equal(killed, true)
    driver.dispose()
  }
})

test('Claude stream-json 保留 tool_use 与 tool_result 的完整生命周期', async () => {
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    spawnSync: (() => ({ status: 0, stdout: 'claude 1.2.3', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      queueMicrotask(() => {
        stdout.write(`${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'claude-call-1', name: 'Read', input: { file_path: 'a.ts' } }] } })}\n`)
        stdout.write(`${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'claude-call-1', content: '文件内容' }] } })}\n`)
        stdout.write(`${JSON.stringify({ type: 'result' })}\n`)
        stdout.end()
        stderr.end()
      })
      return { stdout, stderr, kill() { return true } }
    }) as never,
  })
  const chunks = []
  for await (const chunk of driver.executeTurn({ sessionId: 'claude-tools', messages: [], prompt: '读取' })) chunks.push(chunk)
  assert.deepEqual(chunks, [
    { type: 'tool-running', toolName: 'Read', callId: 'claude-call-1', input: '{"file_path":"a.ts"}', status: 'running' },
    { type: 'tool-running', toolName: 'tool', callId: 'claude-call-1', output: '文件内容', outputMode: 'snapshot', status: 'completed' },
    { type: 'finish', reason: 'stop' },
  ])
})
