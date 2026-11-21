import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { AntigravityDriver } from '../data/build/dist/host/cli-adapters/antigravity-driver.js'
import { readAntigravityToolDetail } from '../data/build/dist/host/cli-adapters/antigravity-tool-detail.js'
import { readAntigravityContextDetails, readAntigravityRequestSamples } from '../data/build/dist/host/cli-adapters/antigravity-session-db.js'
import { CodingNsDshMessageProjector } from '../data/build/dist/host/cli-adapters/dsh-message-projector.js'
import type { CodingNsNativeSessionBridge } from '../src/host/native-session-bridge.js'

const providerSessionId = 'b115d29e-aac7-4e23-afbb-8413240ea0e0'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGNkaPj/n4GBgYEJRIAwACUZAoKPUI0GAAAAAElFTkSuQmCC', 'base64')

function varint(value: number): Buffer {
  const bytes: number[] = []
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128) } while (value)
  return Buffer.from(bytes)
}
function field(index: number, value: string | Uint8Array | number): Buffer {
  if (typeof value === 'number') return Buffer.concat([varint(index * 8), varint(value)])
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value)
  return Buffer.concat([varint(index * 8 + 2), varint(bytes.length), bytes])
}

/** AGY 1.5.9 实测 SQLite step_payload 形状：metadata.tool_call + tool_execution.result。 */
function nativeStep(name: string, parameters: Record<string, unknown>, output?: string, image?: Buffer): Buffer {
  const result = Buffer.concat([
    ...(output === undefined ? [] : [field(1, output)]),
    ...(image === undefined ? [] : [field(4, Buffer.concat([field(1, 'image/png'), field(2, image)]))]),
  ])
  return Buffer.concat([
    field(1, 132), field(4, 3),
    field(5, field(4, Buffer.concat([field(1, 'native-call-id'), field(2, name), field(3, JSON.stringify(parameters))]))),
    field(140, field(2, result)),
  ])
}

function database(t: { after(callback: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'codingns-agy-history-'))
  const path = join(root, `${providerSessionId}.db`)
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB, metadata BLOB)')
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, path, db, insert: (index: number, payload: Buffer) => db.prepare('INSERT INTO steps VALUES (?, 132, ?, ?)').run(index, payload, Buffer.from('native-call-id')) }
}

test('Antigravity reads the latest compaction threshold and estimated context groups', t => {
  const { root, path, db } = database(t)
  assert.equal(readAntigravityContextDetails(providerSessionId, root), null)
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)')
  const insert = db.prepare('INSERT INTO gen_metadata VALUES (?, ?)')
  const group = (type: number, tokens: number) => field(1, Buffer.concat([field(2, type), field(4, tokens)]))
  const metadata = (threshold: number, groups: Buffer[] = []) => field(1, field(9, field(10, Buffer.concat([
    field(1, 14_262), field(4, threshold), field(3, Buffer.concat(groups)),
  ]))))
  insert.run(0, metadata(256_000))
  insert.run(1, Buffer.concat([field(4, 1_048_576), metadata(512_000, [
    group(1, 3_670), group(2, 6_959), group(4, 200), group(5, 1_119), group(6, 689), group(7, 1_825),
  ])]))
  const before = readFileSync(path)
  assert.deepEqual(readAntigravityContextDetails(providerSessionId, root), {
    compactionThreshold: 512_000, breakdown: { systemTokens: 3_670, toolsTokens: 7_159, messageTokens: 1_825 },
  })
  assert.deepEqual(readFileSync(path), before)
  insert.run(2, metadata(640_000))
  assert.deepEqual(readAntigravityContextDetails(providerSessionId, root), { compactionThreshold: 640_000, breakdown: {} })
  insert.run(3, Buffer.from([10, 100]))
  assert.equal(readAntigravityContextDetails(providerSessionId, root), null)
  assert.equal(readAntigravityContextDetails('../other', root), null)
})

function scriptedDriver(root: string, steps: readonly Record<string, unknown>[], options: {
  readonly readToolDetail?: NonNullable<ConstructorParameters<typeof AntigravityDriver>[0]>['readToolDetail']
  readonly result?: Record<string, unknown> | null
} = {}) {
  return new AntigravityDriver({
    autoUpdater: { check() {}, dispose() {} }, binaries: ['fake-agy'],
    resolveContextWindow: () => undefined, resolveModelId: () => null,
    readToolDetail: options.readToolDetail ?? (request => readAntigravityToolDetail(request, root)),
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.5.9', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(), stderr = new PassThrough()
      let emitted = false
      return { stdout, stderr, stdin: { end() {
        if (emitted) return
        emitted = true
        queueMicrotask(() => {
          for (const step of steps) stdout.write(JSON.stringify({ event: 'step_update', step_update: { conversation_id: providerSessionId, step_type: 'tool', ...step } }) + '\n')
          stdout.end(options.result === null ? undefined : JSON.stringify({ event: 'result', result: { conversation_id: providerSessionId, status: 'SUCCESS', ...options.result } }) + '\n')
          stderr.end()
        })
      } }, kill() { return true } }
    }) as never,
  })
}

test('Antigravity 用原生调用详情补齐摘要事件，在落盘前保存正文、diff、读取结果和图片', async t => {
  const native = database(t)
  native.insert(2, nativeStep('read_file', { Path: '/w/a.txt' }, '1: ORIGINAL_TEXT'))
  native.insert(4, nativeStep('write_file', { Path: '/w/a.txt', Content: 'BEFORE', Overwrite: true }, 'Created file.'))
  native.insert(6, nativeStep('edit_file', { Path: '/w/a.txt', Target: 'BEFORE', Replacement: 'AFTER' }, 'Made 1 replacement.'))
  native.insert(8, nativeStep('read_file', { Path: '/w/image.png' }, 'Showing binary file of type image/png', png))
  const before = readFileSync(native.path)
  const steps = [[2, 'read_file', '/w/a.txt'], [4, 'write_file', '/w/a.txt'], [6, 'edit_file', '/w/a.txt'], [8, 'read_file', '/w/image.png']] as const
  const driver = scriptedDriver(native.root, steps.flatMap(([step_index, name, Path]) => [
    { step_index, state: 'ACTIVE', tool_info: { name, parameters: { Path } } },
    { step_index, state: 'DONE', tool_info: { name, parameters: { Path }, ...(step_index === 2 ? { output: '1 lines, 13 bytes' } : {}) } },
  ]))
  t.after(() => driver.dispose())
  const calls: Parameters<NonNullable<CodingNsNativeSessionBridge['appendToolCall']>>[1][] = []
  const results: Parameters<NonNullable<CodingNsNativeSessionBridge['appendToolResult']>>[1][] = []
  const admitted: unknown[] = []
  const projector = new CodingNsDshMessageProjector({ sessionId: 'history', adapterId: 'antigravity', nativeSessions: {
    appendToolCall(sessionId, call) { calls.push(call); return { sessionId, turn: 1, step: 1, callId: call.callId, callSeq: calls.length } },
    appendToolResult(_handle, result) { results.push(result); return true },
    async admitImageArtifact(image) {
      admitted.push(image)
      return { attachmentId: 'sha256:controlled-image', mediaType: 'image/png', bytes: png.length, width: 2, height: 2 }
    },
  } })
  for await (const event of driver.executeTurn({ sessionId: 'history', messages: [], prompt: 'test' })) {
    await projector.push(event)
    if (event.type === 'tool-event' && event.status === 'running') assert.equal(results.length, calls.length - 1)
  }
  assert.equal(calls.length, 4)
  assert.equal(results.length, 4)
  assert.equal(new Set(calls.map(call => call.callId)).size, 4)
  assert.deepEqual(JSON.parse(calls[1]!.arguments), { file_path: '/w/a.txt', content: 'BEFORE', Overwrite: true })
  assert.deepEqual(JSON.parse(calls[2]!.arguments), { file_path: '/w/a.txt', old_string: 'BEFORE', new_string: 'AFTER' })
  assert.equal(results[0]!.output, '1: ORIGINAL_TEXT')
  assert.deepEqual(results[1]!.meta, { diffs: [{ path: '/w/a.txt', oldText: null, newText: 'BEFORE' }] })
  assert.deepEqual(results[2]!.meta, { diffs: [{ path: '/w/a.txt', oldText: 'BEFORE', newText: 'AFTER' }] })
  assert.equal(results[3]!.images?.length, 1)
  assert.deepEqual(admitted, [{ type: 'image-artifact', data: png.toString('base64'), mediaType: 'image/png' }])
  assert.deepEqual(readFileSync(native.path), before, '原生数据库不得回写')
})

test('Antigravity 只读取当前会话及匹配索引、工具名和路径的记录，不读取用户文件', t => {
  const native = database(t)
  native.insert(2, nativeStep('read_file', { Path: '/not-on-disk/source.txt' }, 'HISTORICAL_BYTES'))
  const request = { providerSessionId, stepIndex: 2, toolName: 'read_file', parameters: { Path: '/not-on-disk/source.txt' } }
  assert.equal(readAntigravityToolDetail(request, native.root)?.output, 'HISTORICAL_BYTES')
  assert.equal(readAntigravityToolDetail({ providerSessionId, toolName: 'read_file', callId: 'native-call-id' }, native.root)?.output, 'HISTORICAL_BYTES')
  assert.equal(readAntigravityToolDetail({ providerSessionId, toolName: 'read_file', callId: 'native-call' }, native.root), null)
  for (const patch of [{ stepIndex: 3 }, { toolName: 'write_file' }, { parameters: { Path: '/other.txt' } }, { providerSessionId: '../outside' }, { providerSessionId: '11111111-1111-1111-1111-111111111111' }]) {
    assert.equal(readAntigravityToolDetail({ ...request, ...patch }, native.root), null)
  }
})

test('Antigravity 原生记录不可用或损坏时保留线协议，不猜测参数和结果', async t => {
  const native = database(t)
  native.insert(2, Buffer.from([0xff, 0xff]))
  assert.equal(readAntigravityToolDetail({ providerSessionId, stepIndex: 2, toolName: 'write_file' }, native.root), null)
  const driver = scriptedDriver(native.root, [
    { step_index: 2, state: 'ACTIVE', tool_info: { name: 'write_file', parameters: { Path: '/absent/result.txt' } } },
    { step_index: 2, state: 'DONE', tool_info: { name: 'write_file', parameters: { Path: '/absent/result.txt' }, output: 'wire output' } },
  ])
  t.after(() => driver.dispose())
  const tools = []
  for await (const event of driver.executeTurn({ sessionId: 'history', messages: [], prompt: 'test' })) if (event.type === 'tool-event') tools.push(event)
  assert.equal(tools.length, 2)
  assert.deepEqual(JSON.parse(tools[1]!.input!), { file_path: '/absent/result.txt' })
  assert.equal(tools[1]!.output, 'wire output')
  assert.equal(tools[1]!.outputImages, undefined)
})

test('Antigravity 原生正文在 DONE 才可用时，首次落盘仍保存完整参数', async t => {
  const native = database(t)
  native.insert(2, nativeStep('write_file', { Path: '/w/late.txt', Content: 'LATE_BODY' }, 'Created file.'))
  let reads = 0
  const driver = scriptedDriver(native.root, [
    { step_index: 2, state: 'ACTIVE', tool_info: { name: 'write_file', parameters: { Path: '/w/late.txt' } } },
    { step_index: 2, state: 'ACTIVE', tool_info: { name: 'write_file', output: 'working' } },
    { step_index: 2, state: 'DONE', tool_info: { name: 'write_file', parameters: { Path: '/w/late.txt' } } },
  ], { readToolDetail: request => ++reads <= 2 ? null : readAntigravityToolDetail(request, native.root) })
  t.after(() => driver.dispose())
  const history = projectedHistory()
  for await (const event of driver.executeTurn({ sessionId: 'history', messages: [], prompt: 'test' })) await history.projector.push(event)
  assert.equal(history.calls.length, 1)
  assert.deepEqual(JSON.parse(history.calls[0]!.arguments), { file_path: '/w/late.txt', content: 'LATE_BODY' })
  assert.equal(history.results.length, 1)
  assert.equal(history.results[0]!.output, 'Created file.')
})

test('Antigravity 等待正文期间的无参数更新不能丢失已收到的路径', async t => {
  const native = database(t)
  const driver = scriptedDriver(native.root, [
    { step_index: 2, state: 'ACTIVE', tool_info: { name: 'write_file', parameters: { Path: '/w/pending.txt' } } },
    { step_index: 2, state: 'ACTIVE', tool_info: { name: 'write_file', output: 'working' } },
    { step_index: 2, state: 'DONE', tool_info: { name: 'write_file', output: 'wire result' } },
  ])
  t.after(() => driver.dispose())
  const history = projectedHistory()
  for await (const event of driver.executeTurn({ sessionId: 'history', messages: [], prompt: 'test' })) await history.projector.push(event)
  assert.equal(history.calls.length, 1)
  assert.deepEqual(JSON.parse(history.calls[0]!.arguments), { file_path: '/w/pending.txt' })
  assert.equal(history.results.length, 1)
  assert.equal(history.results[0]!.output, 'wire result')
  assert.equal(history.results[0]!.meta, undefined)
})

for (const reason of ['stop', 'error', 'cancel', 'exit'] as const) {
  test(`Antigravity 等待正文时 ${reason} 闭合原调用，保留路径且不伪造正文`, async t => {
    const native = database(t)
    const driver = scriptedDriver(native.root, [
      { step_index: 2, state: 'ACTIVE', tool_info: { name: 'write_file', parameters: { Path: '/w/pending.txt' } } },
    ], { result: reason === 'exit' || reason === 'cancel' ? null : reason === 'error' ? { status: 'ERROR', error: 'provider failed' } : {} })
    t.after(() => driver.dispose())
    const controller = new AbortController()
    const history = projectedHistory()
    try {
      for await (const event of driver.executeTurn({ sessionId: 'history', messages: [], prompt: 'test', signal: controller.signal })) {
        await history.projector.push(event)
        if (reason === 'cancel' && event.type === 'tool-event') controller.abort()
      }
    } catch (error) {
      assert.equal(reason, 'exit')
      await history.projector.fail(String(error))
    }
    assert.equal(history.calls.length, 1)
    assert.deepEqual(JSON.parse(history.calls[0]!.arguments), { file_path: '/w/pending.txt' })
    assert.equal(history.results.length, 1)
    assert.equal(history.results[0]!.isError, reason !== 'stop')
    assert.equal(history.results[0]!.meta, undefined)
  })
}

test('Antigravity 原生错误补齐失败结果，wire 错误优先且 ACTIVE 不提前失败', async t => {
  const native = database(t)
  native.insert(2, Buffer.concat([
    nativeStep('read_file', { Path: '/w/missing.txt' }),
    field(31, Buffer.concat([field(2, 'file does not exist'), field(3, 'file does not exist')])),
  ]))
  for (const wireError of [undefined, 'wire failure']) {
    const driver = scriptedDriver(native.root, [
      { step_index: 2, state: 'ACTIVE', tool_info: { name: 'read_file', parameters: { Path: '/w/missing.txt' } } },
      { step_index: 2, state: 'DONE', tool_info: { name: 'read_file', parameters: { Path: '/w/missing.txt' }, error: wireError } },
    ])
    t.after(() => driver.dispose())
    const history = projectedHistory()
    for await (const event of driver.executeTurn({ sessionId: 'history', messages: [], prompt: 'test' })) {
      await history.projector.push(event)
      if (event.type === 'tool-event' && event.status === 'running') assert.equal(history.results.length, 0)
    }
    assert.equal(history.calls.length, 1)
    assert.equal(history.results.length, 1)
    assert.equal(history.results[0]!.isError, true)
    assert.equal(history.results[0]!.error, wireError ?? 'file does not exist')
    assert.equal(history.results[0]!.output, wireError ?? 'file does not exist')
  }
})

function projectedHistory() {
  const calls: Parameters<NonNullable<CodingNsNativeSessionBridge['appendToolCall']>>[1][] = []
  const results: Parameters<NonNullable<CodingNsNativeSessionBridge['appendToolResult']>>[1][] = []
  const projector = new CodingNsDshMessageProjector({ sessionId: 'history', adapterId: 'antigravity', nativeSessions: {
    appendToolCall(sessionId, call) { calls.push(call); return { sessionId, turn: 1, step: 1, callId: call.callId, callSeq: calls.length } },
    appendToolResult(_handle, result) { results.push(result); return true },
  } })
  return { calls, results, projector }
}

test('Antigravity reads completed model calls from planner steps for ACP throughput', t => {
  const { root, db } = database(t)
  const timestamp = (seconds: number, nanos: number) => Buffer.concat([field(1, seconds), field(2, nanos)])
  // 实测 planner response metadata：1=开始，7=完成，9.2=输入，9.3=输出，9.5=缓存读取。
  const planner = (start: [number, number], done: [number, number] | null, usage: { input: number; output: number; cache: number }) => Buffer.concat([
    field(1, timestamp(...start)),
    ...(done === null ? [] : [field(7, timestamp(...done))]),
    field(9, Buffer.concat([field(2, usage.input), field(3, usage.output), field(5, usage.cache)])),
  ])
  const insert = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)')
  insert.run(3, 15, null, planner([1_795_274_000, 0], [1_795_274_002, 500_000_000], { input: 100, output: 50, cache: 10 }))
  insert.run(4, 132, null, Buffer.from('tool'))
  insert.run(7, 15, null, planner([1_795_274_561, 947_657_000], [1_795_274_567, 283_058_000], { input: 5_179, output: 386, cache: 328_439 }))
  insert.run(9, 15, null, planner([1_795_274_570, 0], null, { input: 1, output: 1, cache: 1 }))
  insert.run(11, 15, null, planner([1_795_274_580, 0], [1_795_274_590, 0], { input: 1, output: 0, cache: 1 }))

  assert.deepEqual(readAntigravityRequestSamples(providerSessionId, 'latest', root), {
    samples: [{ stepIndex: 7, startedAt: 1_795_274_561_947, completedAt: 1_795_274_567_283, outputTokens: 386, contextTokens: 333_618 }],
    lastStepIndex: 11,
  })
  assert.deepEqual(readAntigravityRequestSamples(providerSessionId, 3, root), {
    samples: [{ stepIndex: 7, startedAt: 1_795_274_561_947, completedAt: 1_795_274_567_283, outputTokens: 386, contextTokens: 333_618 }],
    lastStepIndex: 11,
  })
  assert.equal(readAntigravityRequestSamples(providerSessionId, -1, root)?.samples.length, 2)
  assert.equal(readAntigravityRequestSamples('../other', -1, root), null)
})
