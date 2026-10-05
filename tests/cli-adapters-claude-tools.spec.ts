import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'
import { CodingNsDshToolHistoryProjector } from '../data/build/dist/host/cli-adapters/dsh-tool-history.js'

/** 用真实 stream-json 事件顺序回放，检查首次持久化的调用参数。 */
async function replay(events: readonly Record<string, unknown>[]) {
  const calls: Record<string, unknown>[] = []
  const results: Record<string, unknown>[] = []
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    spawnSync: (() => ({ status: 0, stdout: 'claude 2.1.288', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      queueMicrotask(() => {
        for (const event of [...events, { type: 'result' }]) stdout.write(`${JSON.stringify(event)}\n`)
        stdout.end()
        stderr.end()
      })
      return { stdout, stderr, kill() { return true } }
    }) as never,
  })
  const projector = new CodingNsDshToolHistoryProjector({
    appendToolCall(sessionId: string, call: Record<string, unknown>) {
      calls.push(call)
      return { sessionId, turn: 1, step: 1, callId: call.callId, callSeq: calls.length }
    },
    appendToolResult(_handle: unknown, result: Record<string, unknown>) {
      results.push(result)
      return true
    },
  } as never, 'claude-tools', 'claude-code')
  const chunks = []
  try {
    for await (const event of driver.executeTurn({ sessionId: 'claude-tools', messages: [], prompt: '检查工具' })) {
      chunks.push(event)
      if (event.type === 'tool-event') projector.observe(event)
    }
    projector.finalize('stop')
    return { calls, results, chunks }
  } finally {
    driver.dispose()
  }
}

const stream = (event: Record<string, unknown>): Record<string, unknown> => ({ type: 'stream_event', event })
const start = (id: string, name: string, index = 0): Record<string, unknown> => stream({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } })
const delta = (partial_json: string, index = 0): Record<string, unknown> => stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } })
const stop = (index = 0): Record<string, unknown> => stream({ type: 'content_block_stop', index })
const snapshot = (id: string, name: string, input: unknown): Record<string, unknown> => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: unknown, is_error = false): Record<string, unknown> => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } })

test('Claude 空起始参数和 JSON 分片只持久化一次完整命令，结果仍正确配对', async () => {
  const input = { command: 'printf "中文\\n"', description: '统计语言文件' }
  const json = JSON.stringify(input)
  const output = await replay([
    start('bash-1', 'Bash', 2),
    delta(json.slice(0, 19), 2),
    delta(json.slice(19, 24), 2),
    delta(json.slice(24), 2),
    stop(2),
    snapshot('bash-1', 'Bash', input),
    result('bash-1', [{ type: 'text', text: '中文' }]),
  ])
  assert.deepEqual(output.calls, [{ callId: 'bash-1', name: 'bash', arguments: json, adapterId: 'claude-code' }])
  assert.deepEqual(output.results, [{ output: '中文', isError: false }])
  assert.equal(output.chunks.some((event) => event.type === 'tool-event' && event.input === '{}'), false)
})

test('Claude 没有参数增量或增量损坏时由完整快照补齐，空参数工具仍保留', async () => {
  const output = await replay([
    start('read-1', 'Read'), stop(),
    snapshot('read-1', 'Read', { file_path: 'src/index.ts' }), result('read-1', '源码'),
    start('edit-1', 'Edit'), delta('{"file_path":'), stop(),
    snapshot('edit-1', 'Edit', { file_path: 'src/index.ts', old_string: 'old', new_string: 'new' }), result('edit-1', '无法修改', true),
    start('empty-1', 'ListResources'), stop(), snapshot('empty-1', 'ListResources', {}), result('empty-1', '无资源'),
    start('empty-2', 'ListResources'), stop(), result('empty-2', '无资源'),
  ])
  assert.deepEqual(output.calls.map((call) => [call.callId, JSON.parse(String(call.arguments))]), [
    ['read-1', { file_path: 'src/index.ts' }],
    ['edit-1', { file_path: 'src/index.ts', old_string: 'old', new_string: 'new' }],
    ['empty-1', {}],
    ['empty-2', {}],
  ])
  assert.equal(output.results[1]?.isError, true)
  assert.equal(output.results.length, 4)
})

test('Claude 多个内容块按索引累积参数，并在后续模型消息复用索引', async () => {
  const output = await replay([
    start('bash-1', 'Bash', 0), start('read-1', 'Read', 1),
    delta('{"command":', 0), delta('{"file_path":', 1),
    delta('"pwd"}', 0), delta('"a.ts"}', 1),
    stop(1), stop(0), result('bash-1', '/workspace'), result('read-1', '内容'),
    stream({ type: 'message_start', message: { id: 'next-message' } }),
    start('bash-2', 'Bash', 0), delta('{"command":"ls"}', 0), stop(0), result('bash-2', 'a.ts'),
  ])
  assert.deepEqual(output.calls.map((call) => [call.callId, JSON.parse(String(call.arguments))]), [
    ['read-1', { file_path: 'a.ts' }], ['bash-1', { command: 'pwd' }], ['bash-2', { command: 'ls' }],
  ])
  assert.equal(output.results.length, 3)
})
