#!/usr/bin/env node
/**
 * 修复 DSH v4 会话日志中未闭合的 compaction 事务。
 *
 * 背景：外部适配器（Codex 0.158 起）的自动压缩只会发送 contextCompaction
 * item 的 started/completed，旧版完成信号 thread/compacted 已废弃。适配器在
 * 过渡期没有补发 end 事件时，会话日志会出现只有 compaction/start 与
 * compaction/summary、没有 compaction/end 的形态；DSH 的关系校验要求
 * compaction 必须由 compaction/end 闭合，于是历史加载以
 *   SessionFormatError: turn/end crosses an open compaction
 * 失败。
 *
 * 本脚本在 compaction/start 的 owner turn 内、turn/end 之前插入一条
 * compaction/end，并把插入点之后的 seq 与全部 seq 引用同步右移一位，使日志
 * 重新满足 DSH v4 关系校验。原始文件会先备份为
 * `session.v4.jsonl.zstd.bak-<timestamp>`。
 *
 * 用法：
 *   node scripts/repair-session-compaction.mjs <sessions-root | session.v4.jsonl.zstd> [--apply] [--dsh-root <DSH 安装目录>]
 *
 * 不带 --apply 时只做只读检查；--dsh-root 指向 DSH 版本安装目录时，
 * 会用 DSH 官方关系校验器复核修复结果（如
 * ~/.local/share/codingns/deepseek-harness/0.2.0-rc.1）。
 */
import { closeSync, copyFileSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 4247762216
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const LOG_FILE = 'session.v4.jsonl.zstd'

/** DSH 的 zstd 帧结构扫描（与 dsh-session-persistence-jsonl 的 scanZstdFrames 一致）。 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/** 解码多帧 zstd 日志为 header 行与事件行。 */
function decodeLog(path) {
  const bytes = readFileSync(path)
  const { frames, tornStart } = scanZstdFrames(bytes)
  if (frames.length === 0) throw new Error('empty or header-less Zstandard session log')
  if (tornStart !== undefined) throw new Error(`torn trailing frame at byte ${tornStart}`)
  const text = Buffer.concat(frames.map((frame) => zstdDecompressSync(bytes.subarray(frame.start, frame.end)))).toString('utf8')
  if (!text.endsWith('\n')) throw new Error('log does not end on a complete record')
  const rawLines = text.slice(0, -1).split('\n')
  const header = JSON.parse(rawLines[0])
  if (header?.type !== 'session' || header?.version !== 4) throw new Error(`unsupported session header: ${rawLines[0].slice(0, 80)}`)
  return { header, headerLine: rawLines[0], rows: rawLines.slice(1) }
}

/** 以 header 独立帧 + 事件帧重新编码，保持 DSH 的物理格式约定。 */
function encodeLog(headerLine, rowLines) {
  const headerFrame = zstdCompressSync(Buffer.from(`${headerLine}\n`, 'utf8'), CHECKSUM_OPTIONS)
  const body = rowLines.length === 0 ? Buffer.alloc(0) : zstdCompressSync(Buffer.from(`${rowLines.join('\n')}\n`, 'utf8'), CHECKSUM_OPTIONS)
  return Buffer.concat([headerFrame, body])
}

/** 收集一条事件携带的全部 seq 引用（v4 关系校验使用的字段）。 */
function readReferences(event) {
  const references = []
  const push = (value, setter) => {
    if (typeof value === 'number') references.push({ value, setter })
  }
  if (typeof event.surfaceOp === 'object' && event.surfaceOp !== null) {
    push(event.surfaceOp.startSeq, (next) => { event.surfaceOp.startSeq = next })
    push(event.surfaceOp.endSeq, (next) => { event.surfaceOp.endSeq = next })
  }
  if (Array.isArray(event.sourceEventSeqs)) {
    event.sourceEventSeqs.forEach((value, index) => push(value, (next) => { event.sourceEventSeqs[index] = next }))
  }
  const data = event.data
  if (data !== null && typeof data === 'object') {
    if (data.shadowedRange !== null && typeof data.shadowedRange === 'object') {
      push(data.shadowedRange.start, (next) => { data.shadowedRange.start = next })
      push(data.shadowedRange.end, (next) => { data.shadowedRange.end = next })
    }
    if (Array.isArray(data.shadowedSeqs)) {
      data.shadowedSeqs.forEach((value, index) => push(value, (next) => { data.shadowedSeqs[index] = next }))
    }
    push(data.headerSeq, (next) => { data.headerSeq = next })
    push(data.sourceEventSeq, (next) => { data.sourceEventSeq = next })
    if (Array.isArray(data.messageSeqs)) {
      data.messageSeqs.forEach((value, index) => push(value, (next) => { data.messageSeqs[index] = next }))
    }
  }
  return references
}

/** 找出没有被 compaction/end（或 session/end-seed）闭合的 compaction/start。 */
function findOpenCompactions(events) {
  const open = []
  let current
  for (const event of events) {
    if (event.type === 'compaction/start') {
      if (current !== undefined) current.overlap = true
      current = { seq: event.seq, id: event.data?.compactionId, turn: event.data?.turn, summarized: false, overlap: false }
      open.push(current)
    } else if (event.type === 'compaction/summary' && current !== undefined) {
      current.summarized = true
    } else if (event.type === 'compaction/end' || event.type === 'session/end-seed') {
      if (current !== undefined) {
        current.closed = true
        current = undefined
      }
    }
  }
  return open.filter((item) => item.closed !== true)
}

/** 计算插入点：owner turn 的 turn/end 之前（compaction/end 必须在 owner turn 打开期间写入）。 */
function planRepair(events, open) {
  if (open.overlap) return { error: 'nested compaction/start overlap requires manual review' }
  if (open.turn === null || open.turn === undefined) return { error: 'compaction opened outside a turn requires manual review' }
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === 'turn/end' && event.data?.turn === open.turn && event.seq > open.seq) return { insertIndex: index }
  }
  return { error: `turn ${open.turn} has no turn/end after the compaction start` }
}

/** 结构自检：seq 连续且引用仍然指向更早的事件。 */
function selfCheck(rows) {
  const events = rows.map((row) => JSON.parse(row))
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].seq !== index) throw new Error(`structure check failed: seq ${events[index].seq} at index ${index}`)
  }
  for (const event of events) {
    for (const reference of readReferences(event)) {
      if (!Number.isInteger(reference.value) || reference.value >= event.seq || reference.value < 0) {
        throw new Error(`structure check failed: ${event.type} at seq ${event.seq} references ${reference.value}`)
      }
    }
  }
}

/** 使用 DSH 官方校验器复核（可选）。 */
async function verifyWithDsh(dshRoot, header, rows) {
  const base = join(dshRoot, 'node_modules', '@deepseek-ai')
  const catalog = await import(pathToFileURL(join(base, 'dsh-session-format-catalog', 'lib', 'index.js')).href)
  const session = await import(pathToFileURL(join(base, 'dsh-session', 'lib', 'index.js')).href)
  const format = await import(pathToFileURL(join(base, 'dsh-session-format-v3-to-v4', 'lib', 'index.js')).href)
  const restore = catalog.sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'transformed' })
  for (const row of rows) {
    format.assertV4RowAdmission(row, session.KNOWN_SESSION_EVENT_TYPES)
    restore.decodeRow(row)
  }
  format.assertReleasedV4Relationships(restore.finish(), session.KNOWN_SESSION_EVENT_TYPES)
}

async function repairLog(path, options) {
  const { header, headerLine, rows } = decodeLog(path)
  const events = rows.map((row) => JSON.parse(row))
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].seq !== index) throw new Error(`seq mismatch at index ${index}: ${events[index].seq}`)
  }
  const opens = findOpenCompactions(events)
  if (opens.length === 0) return { status: 'clean' }
  if (opens.length > 1) return { status: 'skip', reason: `multiple open compactions: ${JSON.stringify(opens)}` }
  const open = opens[0]
  const plan = planRepair(events, open)
  if (plan.error !== undefined) return { status: 'skip', reason: plan.error }

  const insertIndex = plan.insertIndex
  const endEvent = {
    type: 'compaction/end',
    seq: insertIndex,
    time: events[insertIndex - 1].time,
    data: {
      compactionId: open.id,
      turn: open.turn,
      // 无摘要的压缩必须带 error，否则 DSH 报 "successful compaction/end requires one summary"。
      ...(open.summarized ? {} : { error: 'Provider 未返回可投影的压缩摘要。' }),
    },
  }

  const nextEvents = []
  const nextRows = []
  const changed = new Set()
  for (let index = 0; index < events.length; index += 1) {
    if (index === insertIndex) {
      nextEvents.push(endEvent)
      nextRows.push(JSON.stringify(endEvent))
      changed.add(nextRows.length - 1)
    }
    const event = events[index]
    if (event.seq >= insertIndex) {
      event.seq += 1
      changed.add(nextRows.length)
    }
    let touched = false
    for (const reference of readReferences(event)) {
      if (reference.value >= insertIndex) {
        reference.setter(reference.value + 1)
        touched = true
      }
    }
    if (touched) changed.add(nextRows.length)
    nextEvents.push(event)
    nextRows.push(rows[index])
  }
  for (const index of changed) nextRows[index] = JSON.stringify(nextEvents[index])

  selfCheck(nextRows)
  if (options.dshRoot !== undefined) await verifyWithDsh(options.dshRoot, header, nextRows.map((row) => JSON.parse(row)))

  if (!options.apply) return { status: 'repairable', open, insertIndex, changedCount: changed.size }
  const backup = `${path}.bak-${new Date().toISOString().replace(/[-:.TZ]/gu, '')}`
  const temp = `${path}.repair.tmp`
  writeFileSync(temp, encodeLog(headerLine, nextRows), { mode: statSync(path).mode & 0o777 })
  try {
    // 落盘前用编码后的字节往返解码，确认物理格式与结构自检都通过再替换原文件。
    const roundTrip = decodeLog(temp)
    selfCheck(roundTrip.rows)
    if (options.dshRoot !== undefined) await verifyWithDsh(options.dshRoot, roundTrip.header, roundTrip.rows.map((row) => JSON.parse(row)))
    const handle = openSync(temp, 'r')
    try { fsyncSync(handle) } finally { closeSync(handle) }
    copyFileSync(path, backup)
    renameSync(temp, path)
  } catch (error) {
    try { unlinkSync(temp) } catch {}
    throw error
  }
  return { status: 'repaired', backup, inserted: endEvent, changedCount: changed.size, bytes: readFileSync(path).length }
}

function collectLogs(root) {
  const targets = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectPath = join(root, project.name)
    for (const session of readdirSync(projectPath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const file = join(projectPath, session.name, LOG_FILE)
      try {
        if (statSync(file).isFile()) targets.push(file)
      } catch {}
    }
  }
  return targets
}

const target = process.argv[2]
const apply = process.argv.includes('--apply')
const dshRootIndex = process.argv.indexOf('--dsh-root')
const dshRoot = dshRootIndex === -1 ? undefined : process.argv[dshRootIndex + 1]
if (target === undefined || dshRootIndex !== -1 && dshRoot === undefined) {
  throw new Error('usage: node scripts/repair-session-compaction.mjs <sessions-root | session.v4.jsonl.zstd> [--apply] [--dsh-root <DSH 安装目录>]')
}
const options = { apply, dshRoot }
if (target.endsWith('.jsonl.zstd')) {
  console.log(JSON.stringify(await repairLog(target, options), null, 2))
} else {
  const targets = collectLogs(target)
  console.log(`scanning ${targets.length} session logs under ${target}`)
  let changed = 0
  for (const file of targets) {
    try {
      const outcome = await repairLog(file, options)
      if (outcome.status === 'clean') continue
      changed += 1
      console.log(`${outcome.status.toUpperCase()} ${file}`)
      console.log(`  ${JSON.stringify(outcome)}`)
    } catch (error) {
      console.log(`ERROR ${file}: ${error.message}`)
    }
  }
  console.log(`done: ${changed} non-clean logs, apply=${apply}`)
}
