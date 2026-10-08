import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import test from 'node:test'
import { createLegacySessionRepair, repairLegacySessionLog, repairLegacySessionLogs } from '../data/build/dist/host/session-migration-repair.js'

test('按会话修复合并并发读取，不读取其他历史日志；不存在的会话允许稍后重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-scoped-'))
  try {
    const target = join(root, '--project--', 'target', 'session.v3.jsonl')
    const unrelated = join(root, '--project--', 'other', 'session.v3.jsonl')
    await mkdir(join(root, '--project--', 'target'), { recursive: true })
    await mkdir(join(root, '--project--', 'other'), { recursive: true })
    await writeFile(target, encodeNone(sampleEvents(false)))
    await writeFile(unrelated, '无关的损坏日志，不能阻塞目标会话')
    const repair = createLegacySessionRepair({ root })
    const first = repair('target')
    assert.equal(repair('target'), first, '并发打开必须共用同一个修复任务')
    assert.deepEqual(await first, { scanned: 1, repaired: 1, skipped: 0, failed: 0 })
    // 移除目标目录后仍返回成功缓存，证明重复打开不重新读取磁盘。
    await rm(join(root, '--project--', 'target'), { recursive: true })
    assert.equal((await repair('target')).scanned, 1)
    assert.equal(await readFile(unrelated, 'utf8'), '无关的损坏日志，不能阻塞目标会话')
    assert.equal((await repair('later')).scanned, 0)
    await mkdir(join(root, '--project--', 'later'))
    await writeFile(join(root, '--project--', 'later', 'session.v3.jsonl'), encodeNone(sampleEvents(false)))
    assert.equal((await repair('later')).repaired, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('按会话查找遵守 DSH 编码，不沿符号链接或递归进入嵌套目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-path-'))
  try {
    const directory = join(root, '_no-cwd', '~002E~002E~002F~4E2D~D83D~DE00~007E')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'session.v3.jsonl'), encodeNone(sampleEvents(false)))
    const report = await repairLegacySessionLogs({ root, sessionId: '../中😀~' })
    // 「..」只有单独作为 ID 时转义；作为前缀允许原样保留，且斜杠始终被编码。
    assert.equal(report.scanned, 0)
    const encoded = join(root, '_no-cwd', '..~002F~4E2D~D83D~DE00~007E')
    await mkdir(encoded)
    await writeFile(join(encoded, 'session.v3.jsonl'), encodeNone(sampleEvents(false)))
    await mkdir(join(encoded, 'nested'))
    await writeFile(join(encoded, 'nested', 'session.v3.jsonl'), '不应读取')
    assert.deepEqual(await repairLegacySessionLogs({ root, sessionId: '../中😀~' }), { scanned: 1, repaired: 1, skipped: 0, failed: 0 })
    await mkdir(join(root, '_no-cwd', '~002E~002E'))
    await writeFile(join(root, '_no-cwd', '~002E~002E', 'session.v3.jsonl'), encodeNone(sampleEvents(false)))
    assert.equal((await repairLegacySessionLogs({ root, sessionId: '..' })).repaired, 1)
    if (process.platform !== 'win32') {
      await symlink(encoded, join(root, '_no-cwd', 'link'))
      assert.equal((await repairLegacySessionLogs({ root, sessionId: 'link' })).scanned, 0)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('按会话检查失败不缓存，文件恢复后可以重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-retry-'))
  try {
    const directory = join(root, '_no-cwd', 'broken')
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'session.v3.jsonl')
    await writeFile(path, '损坏日志')
    const repair = createLegacySessionRepair({ root })
    assert.equal((await repair('broken')).failed, 1)
    await writeFile(path, encodeNone(sampleEvents(false)))
    assert.equal((await repair('broken')).repaired, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('自动修复裸 tool/call 并重映射后续引用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-test-'))
  try {
    const path = join(root, 'session.v3.jsonl')
    const original = encodeNone(sampleEvents(false))
    await writeFile(path, original)

    assert.equal(await repairLegacySessionLog(path), true)
    const repaired = decodeNone(await readFile(path))
    assert.deepEqual(repaired.events.map((event) => [event.seq, event.type]), [
      [0, 'turn/start'],
      [1, 'step/start'],
      [2, 'assistant/message'],
      [3, 'tool/call'],
      [4, 'tool/result'],
    ])
    assert.deepEqual(repaired.events[4]?.sourceEventSeqs, [3])
    assert.equal((await stat(`${path}.codingns-repair-backup`)).isFile(), true)
    assert.equal((await repairLegacySessionLog(path)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zstd 历史日志支持多个裸调用，已有声明不会重复插入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-zstd-'))
  try {
    const path = join(root, 'session.v3.jsonl.zstd')
    await writeFile(path, encodeZstd(sampleEvents(true)))
    assert.equal((await repairLegacySessionLogs({ root })).repaired, 1)
    const repaired = decodeZstd(await readFile(path))
    assert.deepEqual(repaired.events.filter((event) => event.type === 'assistant/message').length, 2)
    assert.deepEqual(repaired.events.filter((event) => event.type === 'tool/call').map((event) => event.seq), [3, 6])
    assert.deepEqual(repaired.events.filter((event) => event.type === 'tool/result').map((event) => event.sourceEventSeqs), [[3], [6]])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('DSH 0.1.7 v4 日志中的裸调用也能在恢复前修复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-v4-'))
  try {
    const path = join(root, 'session.v4.jsonl.zstd')
    await writeFile(path, encodeZstd(sampleEvents(false)))
    assert.equal((await repairLegacySessionLogs({ root })).repaired, 1)
    const repaired = decodeZstd(await readFile(path))
    assert.deepEqual(repaired.events.map((event) => [event.seq, event.type]), [
      [0, 'turn/start'],
      [1, 'step/start'],
      [2, 'assistant/message'],
      [3, 'tool/call'],
      [4, 'tool/result'],
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('DSH 0.1.7 v4 日志中的旧 tool-result wrapper 会提升为 tool-role 消息', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-v4-wrapper-'))
  try {
    const path = join(root, 'session.v4.jsonl')
    const rows = sampleEvents(false)
    rows[0] = { type: 'session', version: 4 }
    await writeFile(path, encodeNone(rows))
    assert.equal(await repairLegacySessionLog(path), true)
    const repaired = decodeNone(await readFile(path))
    const message = repaired.events.find((event) => event.type === 'tool/result')?.data?.message
    assert.deepEqual(message, {
      id: 'one-result',
      role: 'tool',
      toolCallId: 'one',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'tool', callId: 'one' },
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('修复外部适配器累积 assistant 消息中的重复 tool-call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-duplicate-tool-call-'))
  try {
    const path = join(root, 'session.v4.jsonl')
    const rows: Array<Record<string, unknown>> = [
      { type: 'session', version: 4 },
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message',
        seq: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'external-first',
            role: 'assistant',
            content: [{ type: 'text', text: '先执行。' }, { type: 'tool-call', id: 'one', name: 'read', arguments: '{}' }],
            source: { kind: 'model', provider: 'codingns-external', model: 'external-agent' },
          },
          stream: [],
        },
        surfaceOp: 'append',
      },
      { type: 'tool/call', seq: 3, data: { turn: 1, step: 1, callId: 'one', name: 'read', arguments: '{}' } },
      {
        type: 'tool/result',
        seq: 4,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'one-result',
            role: 'tool',
            toolCallId: 'one',
            content: [{ type: 'text', text: 'ok' }],
            source: { kind: 'tool', callId: 'one' },
          },
        },
        sourceEventSeqs: [3],
        surfaceOp: 'append',
      },
      {
        type: 'assistant/message',
        seq: 5,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'external-second',
            role: 'assistant',
            content: [
              { type: 'text', text: '继续执行。' },
              { type: 'tool-call', id: 'one', name: 'read', arguments: '{}' },
              { type: 'tool-call', id: 'two', name: 'write', arguments: '{}' },
            ],
            source: { kind: 'model', provider: 'codingns-external', model: 'external-agent' },
          },
          stream: [],
        },
        surfaceOp: 'append',
      },
      { type: 'tool/call', seq: 6, data: { turn: 1, step: 1, callId: 'two', name: 'write', arguments: '{}' } },
      {
        type: 'tool/result',
        seq: 7,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'two-result',
            role: 'tool',
            toolCallId: 'two',
            content: [{ type: 'text', text: 'ok' }],
            source: { kind: 'tool', callId: 'two' },
          },
        },
        sourceEventSeqs: [6],
        surfaceOp: 'append',
      },
      { type: 'step/end', seq: 8, data: { turn: 1, step: 1 } },
      { type: 'turn/end', seq: 9, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    await writeFile(path, encodeNone(rows))

    assert.equal(await repairLegacySessionLog(path), true)
    const repaired = decodeNone(await readFile(path))
    const message = repaired.events.find((event) => event.type === 'assistant/message' && event.data?.message?.id === 'external-second')
    assert.deepEqual(message?.data?.message?.content, [
      { type: 'text', text: '继续执行。' },
      { type: 'tool-call', id: 'two', name: 'write', arguments: '{}' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('修复失败时保持原文件不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-failure-'))
  try {
    const path = join(root, 'session.v3.jsonl')
    const original = Buffer.from('{"type":"session"}\n{"type":"tool/call","seq":9}\n')
    await writeFile(path, original)
    await assert.rejects(() => repairLegacySessionLog(path))
    assert.deepEqual(await readFile(path), original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function sampleEvents(withExistingDeclaration: boolean): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    { type: 'session' },
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    ...(withExistingDeclaration
      ? [{
          type: 'assistant/message',
          seq: 2,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'declared-one',
              role: 'assistant',
              content: [{ type: 'tool-call', id: 'one', name: 'read', arguments: '{}' }],
              source: { kind: 'model', provider: 'test', model: 'test' },
            },
            stream: [],
          },
          surfaceOp: 'append',
        }]
      : []),
    {
      type: 'tool/call',
      seq: withExistingDeclaration ? 3 : 2,
      data: { turn: 1, step: 1, callId: 'one', name: 'read', arguments: '{}' },
    },
    {
      type: 'tool/result',
      seq: withExistingDeclaration ? 4 : 3,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'one-result',
          role: 'user',
          toolCallId: 'one',
          content: [{ type: 'tool-result', toolCallId: 'one', content: [{ type: 'text', text: 'ok' }] }],
          source: { kind: 'tool', callId: 'one' },
        },
      },
      sourceEventSeqs: [withExistingDeclaration ? 3 : 2],
      surfaceOp: 'append',
    },
  ]
  if (!withExistingDeclaration) return events
  events.push(
    { type: 'tool/call', seq: 5, data: { turn: 1, step: 1, callId: 'two', name: 'write', arguments: '{}' } },
    {
      type: 'tool/result',
      seq: 6,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'two-result',
          role: 'user',
          toolCallId: 'two',
          content: [{ type: 'tool-result', toolCallId: 'two', content: [{ type: 'text', text: 'ok' }] }],
          source: { kind: 'tool', callId: 'two' },
        },
      },
      sourceEventSeqs: [5],
      surfaceOp: 'append',
    },
  )
  return events
}

function encodeNone(rows: readonly Record<string, unknown>[]): Buffer {
  return Buffer.from(`${rows.map((row) => `${JSON.stringify(row)}\n`).join('')}`)
}

function decodeNone(bytes: Buffer): { events: Array<Record<string, any>> } {
  const rows = bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
  return { events: rows.slice(1) }
}

function encodeZstd(rows: readonly Record<string, unknown>[]): Buffer {
  const header = `${JSON.stringify(rows[0])}\n`
  const body = rows.slice(1).map((row) => `${JSON.stringify(row)}\n`).join('')
  return Buffer.concat([zstdCompressSync(Buffer.from(header)), zstdCompressSync(Buffer.from(body))])
}

function decodeZstd(bytes: Buffer): { events: Array<Record<string, any>> } {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < bytes.length) {
    const next = bytes.indexOf(magic, offset + 1)
    chunks.push(zstdDecompressSync(bytes.subarray(offset, next < 0 ? bytes.length : next)))
    offset = next < 0 ? bytes.length : next
  }
  const rows = Buffer.concat(chunks).toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
  return { events: rows.slice(1) }
}
