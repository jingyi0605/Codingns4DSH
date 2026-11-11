import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { ClaudeCodeDriver } from '../src/host/cli-adapters/claude-driver.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsDshMessageProjector, type CodingNsDshStreamChunk } from '../src/host/cli-adapters/dsh-message-projector.js'
import { createCodingNsNativeSessionBridge } from '../src/host/native-session-bridge.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }
const attachment = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: Buffer.from(PNG, 'base64').length, width: 1, height: 1 }
const call = (id: string, name: string, input: object) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } })
const result = (id: string, content: unknown, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } })

/** 回放真实形状的 Claude 记录，经 Registry 分段和消息投影写入原生时间线。 */
async function replay(rows: readonly object[], cancelAfterCallId?: string, resumedRows?: readonly object[]) {
  const controller = new AbortController()
  const events: Array<{ type: string; seq: number; data: Record<string, any> }> = []
  const admitted: unknown[] = []
  let starts = 0
  let closed = false
  const sessionId = 'claude-tool-history'
  const session = {
    header: { version: 4, id: sessionId },
    snapshotEvents: () => [...events],
    append(type: string, data: Record<string, any>) {
      const event = { type, seq: events.length, data }
      events.push(event)
      return event
    },
  }
  const bridge = createCodingNsNativeSessionBridge({
    get(name: string) {
      if (name === 'sessions') return { get: () => session, list: () => [session] }
      if (name === 'attachments') return {
        async admitPromptContent(content: unknown[]) {
          admitted.push(...content)
          return [{ type: 'image', attachment }]
        },
        async admitEncodedFile() {},
        async *readFileStream() {},
      }
      return undefined
    },
  } as never)
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    spawnSync: (() => ({ status: 0, stdout: 'claude 2.1.317 --effort', stderr: '' })) as never,
    spawn: (() => {
      starts += 1
      const turnRows = starts === 1 ? rows : resumedRows ?? rows
      const stdout = new PassThrough(), stderr = new PassThrough()
      queueMicrotask(() => {
        for (const row of turnRows) stdout.write(`${JSON.stringify(row)}\n`)
        stdout.end()
        stderr.end()
      })
      return Object.assign(new EventEmitter(), { stdout, stderr, stdin: new PassThrough(), kill() { closed = true; return true } })
    }) as never,
  })
  const registry = new CodingNsCliAdapterRegistry([driver])
  const batches: string[][] = []
  const chunks: CodingNsDshStreamChunk[] = []
  try {
    for (const turn of resumedRows === undefined ? [1] : [1, 2]) {
      session.append('turn/start', { turn })
      for (let step = 1; step <= Math.max(rows.length, resumedRows?.length ?? 0) + 1; step += 1) {
        session.append('step/start', { turn, step })
        const projector = new CodingNsDshMessageProjector({ adapterId: 'claude-code', sessionId, nativeSessions: bridge, signal: controller.signal })
        const completed: string[] = []
        let suspended = false
        try {
          for await (const event of registry.execute({ adapterId: 'claude-code', sessionId, messages: [], prompt: 'Read the image', splitToolSteps: true, signal: controller.signal })) {
            if (event.type === 'step-boundary') suspended = true
            if (event.type === 'tool-event' && (event.status === 'completed' || event.status === 'failed')) completed.push(event.callId!)
            chunks.push(...await projector.push(event))
            if (event.type === 'tool-event' && event.status === 'completed' && event.callId === cancelAfterCallId) controller.abort()
          }
          chunks.push(...await projector.complete(controller.signal.aborted ? 'cancel' : 'stop'))
        } catch (error) {
          chunks.push(...await projector.fail(String(error), controller.signal.aborted))
          throw error
        }
        batches.push(completed)
        session.append('step/end', { turn, step })
        if (!suspended) break
      }
      session.append('turn/end', { turn })
    }
    return { events, admitted, batches, chunks, starts, closed }
  } finally { await registry.dispose() }
}

for (const failed of [false, true]) test(`Claude 并行 Bash 和 Read 在整批返回后分步，失败=${failed}`, async () => {
  const output = await replay([
    call('bash-1', 'Bash', { command: 'prepare image' }),
    call('read-1', 'Read', { file_path: 'tiny.png' }),
    result('bash-1', 'prepared'),
    result('read-1', failed ? 'File missing' : [image], failed),
    { type: 'result' },
  ])
  assert.deepEqual(output.batches, [['bash-1', 'read-1'], []])
  assert.equal(output.starts, 1)
  assert.equal(output.closed, true)
  const calls = output.events.filter(event => event.type === 'tool/call')
  const results = output.events.filter(event => event.type === 'tool/result')
  assert.equal(calls.length, 2)
  assert.equal(results.length, 2)
  assert.equal(calls[1]?.data.arguments, '{"file_path":"tiny.png"}')
  const read = results.find(event => event.data.message.toolCallId === 'read-1')!
  assert.equal(read.data.step, 1)
  if (failed) {
    assert.equal(read.data.message.isError, true)
    assert.deepEqual(read.data.message.content, [{ type: 'text', text: 'File missing' }])
  } else {
    assert.deepEqual(read.data.message.content, [{ type: 'image', attachment }])
    assert.equal(JSON.stringify(output.events).includes(PNG), false)
    assert.deepEqual(output.admitted, [{ type: 'image', mediaType: 'image/png', data: PNG }])
  }
})

test('Claude 图片和说明文字都进入工具结果，保留多张图片顺序', async () => {
  const output = await replay([
    call('read-1', 'Read', { file_path: 'tiny.png' }),
    result('read-1', [{ type: 'text', text: 'First page' }, image, image]),
    { type: 'result' },
  ])
  const resultEvent = output.events.find(event => event.type === 'tool/result')!
  assert.deepEqual(resultEvent.data.message.content, [{ type: 'text', text: 'First page' }, { type: 'image', attachment }, { type: 'image', attachment }])
  assert.equal(output.admitted.length, 2)
  assert.equal(JSON.stringify(output.chunks).includes(PNG), false)
})

test('Claude 长工具的 tool_progress 心跳不创建虚假调用，也不阻断后续分步', async () => {
  const output = await replay([
    call('bash-1', 'Bash', { command: 'long task' }),
    ...[0, 1].map(index => ({
      type: 'tool_progress', tool_use_id: `bash-1-heartbeat-${index}`, tool_name: 'Bash',
      parent_tool_use_id: null, elapsed_time_seconds: 30 * (index + 1), heartbeat: true,
      session_id: 'provider-session', uuid: `progress-${index}`,
    })),
    result('bash-1', 'done'),
    call('read-1', 'Read', { file_path: 'result.txt' }),
    result('read-1', 'verified'),
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Final answer' } } },
    { type: 'result' },
  ])
  assert.deepEqual(output.batches, [['bash-1'], ['read-1'], []])
  assert.deepEqual(output.events.filter(event => event.type === 'tool/call').map(event => event.data.callId), ['bash-1', 'read-1'])
  assert.equal(output.events.filter(event => event.type === 'tool/result').length, 2)
  assert.equal(output.starts, 1)
  assert.equal(output.closed, true)
})

test('Claude 出错后同一会话续跑，长工具心跳不污染新回合的分步和历史', async () => {
  const output = await replay([
    call('interrupted', 'Bash', { command: 'interrupted task' }),
    { type: 'result', is_error: true, errors: ['ECONNRESET'] },
  ], undefined, [
    call('resumed', 'Bash', { command: 'resume task' }),
    { type: 'tool_progress', tool_use_id: 'resumed-heartbeat-0', tool_name: 'Bash', elapsed_time_seconds: 30, heartbeat: true },
    result('resumed', 'done'),
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Final answer' } } },
    { type: 'result' },
  ])
  assert.deepEqual(output.batches, [[], ['resumed'], []])
  const calls = output.events.filter(event => event.type === 'tool/call')
  assert.deepEqual(calls.map(event => [event.data.callId, event.data.turn, event.data.step]), [['interrupted', 1, 1], ['resumed', 2, 1]])
  const results = output.events.filter(event => event.type === 'tool/result')
  assert.deepEqual(results.map(event => event.data.message.isError === true), [true, false])
  assert.equal(output.starts, 2)
  assert.equal(output.closed, true)
})

test('Claude 并行工具尚未全部返回就报错时，未完成 Read 记录失败而非空成功', async () => {
  const output = await replay([
    call('bash-1', 'Bash', { command: 'prepare image' }),
    call('read-1', 'Read', { file_path: 'tiny.png' }),
    result('bash-1', 'prepared'),
    { type: 'result', is_error: true, errors: ['Provider failed'] },
  ])
  assert.deepEqual(output.batches, [['bash-1']])
  const read = output.events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'read-1')!
  assert.equal(read.data.message.isError, true)
  assert.equal(output.closed, true)
})

test('Claude 并行工具未全部返回时取消，未完成 Read 只记录一次失败并释放进程', async () => {
  const output = await replay([
    call('bash-1', 'Bash', { command: 'prepare image' }),
    call('read-1', 'Read', { file_path: 'tiny.png' }),
    result('bash-1', 'prepared'),
  ], 'bash-1')
  assert.deepEqual(output.batches, [['bash-1']])
  const calls = output.events.filter(event => event.type === 'tool/call' && event.data.callId === 'read-1')
  const results = output.events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === 'read-1')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.data.arguments, '{"file_path":"tiny.png"}')
  assert.equal(results.length, 1)
  assert.equal(results[0]?.data.message.isError, true)
  assert.deepEqual(output.chunks.find(chunk => chunk.type === 'finish'), {
    type: 'finish', reason: { kind: 'aborted', failure: { message: '外部 Agent 执行已取消', code: 'ABORTED' } },
  })
  assert.equal(output.starts, 1)
  assert.equal(output.closed, true)
})
