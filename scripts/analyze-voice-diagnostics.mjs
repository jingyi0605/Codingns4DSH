import { readFile, readdir, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 选择最近写入真实指标的运行，跳过自检和只有启动标记的文件。
const target = process.argv[2] ?? fileURLToPath(new URL('../data/logs', import.meta.url))
let files = []
if ((await stat(target)).isFile()) files = [target]
else {
  const names = (await readdir(target)).filter((name) => /^voice-performance-.+\.\d+\.jsonl$/u.test(name)).sort()
  const groups = new Map()
  for (const name of names) {
    const prefix = name.replace(/\.\d+\.jsonl$/u, '')
    const group = groups.get(prefix) ?? { files: [], latestTime: 0, activity: false }
    const file = join(target, name)
    group.files.push(file)
    // 扫描时只保留运行元数据，多个旧运行日志不会一起进入内存。
    const input = createReadStream(file)
    const lines = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        try {
          const record = JSON.parse(line)
          if (record === null || typeof record !== 'object' || typeof record.event !== 'string') continue
          if (/^(host|client)\./u.test(record.event)) group.activity = true
          const time = Date.parse(record.receivedAt ?? record.timestamp)
          if (Number.isFinite(time)) group.latestTime = Math.max(group.latestTime, time)
        } catch { /* 文件可能仍在追加，扫描阶段忽略未完整的末行 */ }
      }
    } finally { lines.close(); input.destroy() }
    groups.set(prefix, group)
  }
  const candidates = [...groups.values()].filter((group) => group.activity).sort((left, right) => right.latestTime - left.latestTime)
  const latest = candidates[0]
  if (latest === undefined) {
    console.log(`检查 ${names.length} 个日志文件，仅有自检或启动记录，尚无真实语音性能指标。`)
    process.exit(0)
  }
  files = latest.files
}
const records = []
let malformed = 0
for (const file of files) {
  const content = await readFile(file, 'utf8')
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try { const record = JSON.parse(line); if (record !== null && typeof record === 'object' && typeof record.event === 'string') records.push(record); else malformed++ } catch { malformed++ }
  }
}
if (records.length === 0) {
  console.log('没有找到语音性能日志；请在加载新版源码的 Stage0 页面复现一次通话。')
  process.exit(0)
}

console.log(`分析 ${files.length} 个文件、${records.length} 条记录，忽略 ${malformed} 条不完整记录。`)
for (const file of files) console.log(`日志：${file}`)
const metrics = [
  ['客户端首字', 'client.turn.first_text', 'firstTextMs'],
  ['Host 模型首字', 'host.llm.first_text', 'firstTextMs'],
  ['首段文字等待', 'client.turn.first_sentence', 'firstSentenceMs'],
  ['首次播放调度', 'client.turn.first_playback_scheduled', 'firstPlaybackMs'],
  ['TTS 首块音频', 'client.tts.first_audio', 'firstAudioMs'],
  ['Host TTS 首块音频', 'host.tts.first_audio', 'firstAudioMs'],
  ['MOSS 通话预热', 'host.tts.warmup.done', 'durationMs'],
  ['TTS 请求准备', 'host.tts.prepared', 'durationMs'],
  ['上传往返', 'client.upload.batch', 'durationMs'],
  ['上传排队', 'client.upload.batch', 'waitMs'],
  ['Host 上传处理', 'host.upload.batch', 'processMs'],
  ['Host 识别最长帧', 'host.asr.metrics', 'maxDecodeMs'],
  ['Host 事件循环最长阻塞', 'host.health', 'eventLoopMaxMs'],
  ['播放断流间隙', 'client.tts.playback_scheduled', 'gapMs'],
]
for (const [label, event, field] of metrics) {
  const values = records.filter((record) => record.event === event).map((record) => record.fields?.[field]).filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  if (values.length === 0) continue
  const percentile = (fraction) => values[Math.max(0, Math.ceil(values.length * fraction) - 1)].toFixed(1)
  console.log(`${label}：样本 ${values.length}，P50 ${percentile(0.5)} ms，P95 ${percentile(0.95)} ms，最大 ${values.at(-1).toFixed(1)} ms`)
}

const phases = new Map()
for (const record of records) {
  if (record.event !== 'host.moss.phase' || ['audio_chunk', 'segment', 'request'].includes(record.fields?.phase)) continue
  const { phase, durationMs, count } = record.fields ?? {}
  if (typeof phase !== 'string' || typeof durationMs !== 'number') continue
  const previous = phases.get(phase) ?? { duration: 0, count: 0 }
  phases.set(phase, { duration: previous.duration + durationMs, count: previous.count + (count ?? 1) })
}
for (const [phase, value] of [...phases].sort((a, b) => b[1].duration - a[1].duration)) console.log(`ONNX ${phase}：累计 ${value.duration.toFixed(1)} ms，${value.count} 次调用`)

const count = (event, field, threshold) => records.filter((record) => record.event === event && record.fields?.[field] > threshold).length
const streamUpdates = records.filter((record) => record.event === 'client.turn.stream_update').length
const fallbackPolls = records.filter((record) => record.event === 'client.turn.poll_fallback').length
if (streamUpdates || fallbackPolls) console.log(`模型文字推送 ${streamUpdates} 次，无推送时降级读取 ${fallbackPolls} 次。`)
const cachedPreparations = records.filter((record) => record.event === 'host.tts.prepared' && record.fields?.cached === true).length
if (cachedPreparations) console.log(`复用通话内安装验证 ${cachedPreparations} 次。`)
for (const record of records.filter((record) => record.event === 'host.assistant.tools')) {
  const fields = record.fields ?? {}
  console.log(`助理搜索工具：${fields.webSearchAvailable === true ? '已开放' : '不可用'}，注册方式 ${fields.searchRegistration ?? '未记录'}；提供商是否可用仍以实际调用结果为准。`)
}
const searchCalls = records.filter((record) => record.event === 'host.llm.tool' && record.fields?.action === 'web_search')
if (searchCalls.length) console.log(`实际联网搜索：发起 ${searchCalls.filter((record) => record.fields?.state === 'running').length} 次，完成 ${searchCalls.filter((record) => record.fields?.state === 'completed').length} 次，失败 ${searchCalls.filter((record) => record.fields?.state === 'failed').length} 次。`)
const underruns = count('client.tts.playback_scheduled', 'gapMs', 100)
const slowTts = count('host.tts.finished', 'realTimeFactor', 1)
const blocked = count('host.health', 'eventLoopMaxMs', 100)
const slowAsr = count('host.asr.metrics', 'realTimeFactor', 1)
const dropped = records.filter((record) => record.event === 'diagnostics.dropped' || record.event === 'diagnostics.client_dropped').reduce((sum, record) => sum + (record.fields?.dropped ?? 0), 0)
for (const record of records.filter((record) => record.event === 'client.upload.error')) {
  const fields = record.fields ?? {}
  console.log(`上传中止：${record.timestamp}，原因 ${fields.code ?? '旧日志未记录原因码'}，积压 ${fields.pendingBytes ?? 0} 字节${typeof fields.pendingAudioMs === 'number' ? `／${fields.pendingAudioMs.toFixed(1)} ms 音频` : ''}${typeof fields.inFlightMs === 'number' ? `，在途等待 ${fields.inFlightMs.toFixed(1)} ms` : ''}。`)
}
const received = new Set(records.filter((record) => record.event === 'host.upload.received' || record.event === 'host.upload.batch').map((record) => record.fields?.diagnosticId))
const finished = new Set(records.filter((record) => record.event === 'client.upload.batch').map((record) => record.fields?.diagnosticId))
const unfinished = records.filter((record) => record.event === 'client.upload.start' && !finished.has(record.fields?.diagnosticId))
for (const record of unfinished) console.log(`未完成上传 ${record.fields?.diagnosticId}：${received.has(record.fields?.diagnosticId) ? 'Host 已收到' : '日志未确认 Host 收到'}；结合超时或中止记录判断。`)
if (underruns) console.log(`发现 ${underruns} 次超过 100 ms 的播放断流；结合 TTS 分块间隔和上传往返继续定位。`)
if (slowTts) console.log(`发现 ${slowTts} 个合成请求耗时超过音频时长；优先检查 ONNX 各图耗时、冷启动与 CPU 竞争。`)
if (blocked || slowAsr) console.log(`Host 阻塞异常 ${blocked} 次、识别速度不足 ${slowAsr} 次；结合上传处理与识别耗时排查 Host 负载，不能仅凭阻塞归因于网络或识别器。`)
if (dropped) console.log(`丢弃诊断 ${dropped} 条，统计不完整；检查回传链路或磁盘写入速度。`)
if (!records.some((record) => record.event === 'client.turn.start')) console.log('尚未形成模型回复轮次；启动和上传阶段的指标仍可用于排查。')
