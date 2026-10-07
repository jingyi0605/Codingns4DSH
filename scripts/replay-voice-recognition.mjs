import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildAssistantVoiceHotwords, prepareSherpaHotwords } from '../src/host/features/assistant-voice-hotwords.js'
import { createSherpaRecognizerConfig } from '../src/host/features/sherpa-voice-runtime.js'

// 显式传入模型与录音清单；不读取默认 Profile、不占用通话租约、不启动服务。
const modes = ['greedy', 'beam', 'hotwords']
const args = process.argv.slice(2)
const normalize = (value) => value.normalize('NFKC').toUpperCase().replace(/[\s\p{Punctuation}]/gu, '')

async function replay(mode, manifest, root) {
  const sherpa = createRequire(import.meta.url)('sherpa-onnx-node')
  const hotwords = mode === 'hotwords' ? await prepareSherpaHotwords(manifest.paths.asrTokens,
    manifest.hotwords ?? buildAssistantVoiceHotwords(manifest.entries ?? [], manifest.managedWorkspaceIds ?? [], manifest.workspaces ?? [])) : undefined
  const started = performance.now()
  let recognizer
  try {
    const config = createSherpaRecognizerConfig(manifest.paths, 16000, 2, 0.8, hotwords)
    if (manifest.maxActivePaths !== undefined) {
      if (![4, 8].includes(manifest.maxActivePaths)) throw new Error('回放束宽只能为 4 或 8')
      config.maxActivePaths = manifest.maxActivePaths
    }
    if (mode === 'greedy') config.decodingMethod = 'greedy_search'
    recognizer = new sherpa.OnlineRecognizer(config)
  } finally { await hotwords?.dispose() }
  const loadMs = performance.now() - started
  const samples = []
  for (const item of manifest.samples) {
    const path = resolve(root, item.file)
    const wave = sherpa.readWave(path)
    if (wave.sampleRate !== 16000 || wave.samples.length === 0) throw new Error(`录音需要 16 kHz 单声道 WAV：${item.file}`)
    const stream = recognizer.createStream()
    const frameLength = 640 // 与生产上传一致，40 ms 一帧。
    const audio = new Float32Array(wave.samples.length + 16000)
    audio.set(wave.samples)
    const audioMs = wave.samples.length / wave.sampleRate * 1000
    let decodeMs = 0; let maxFrameMs = 0; let firstTextAudioMs = null; let endpointAudioMs = null
    const finals = []
    const decode = (position) => {
      let iterations = 0
      while (recognizer.isReady(stream)) {
        if (++iterations > 1000) throw new Error('识别解码未能正常结束')
        recognizer.decode(stream)
        const text = recognizer.getResult(stream).text?.trim() ?? ''
        if (text && firstTextAudioMs === null) firstTextAudioMs = position / 16000 * 1000
        if (recognizer.isEndpoint(stream)) {
          if (text) { finals.push(text); endpointAudioMs = position / 16000 * 1000 }
          recognizer.reset(stream)
        }
      }
    }
    for (let offset = 0; offset < audio.length; offset += frameLength) {
      const frameStarted = performance.now()
      const end = Math.min(offset + frameLength, audio.length)
      stream.acceptWaveform({ sampleRate: 16000, samples: audio.subarray(offset, end) })
      decode(end)
      const frameMs = performance.now() - frameStarted
      decodeMs += frameMs; maxFrameMs = Math.max(maxFrameMs, frameMs)
    }
    const finishStarted = performance.now()
    stream.inputFinished(); decode(audio.length)
    decodeMs += performance.now() - finishStarted
    const tail = recognizer.getResult(stream).text?.trim() ?? ''
    if (tail) finals.push(tail)
    const text = finals.join(' ')
    const termMatch = item.expectedTerms?.length > 0 ? item.expectedTerms.every((term) => normalize(text).includes(normalize(term))) : null
    const falseCorrection = (item.forbiddenTerms ?? []).some((term) => normalize(text).includes(normalize(term)))
    samples.push({ id: item.id, category: item.category, audioSha256: createHash('sha256').update(await readFile(path)).digest('hex'),
      reference: item.reference, text, termMatch, falseCorrection, audioMs, decodeMs, maxFrameMs, realTimeFactor: decodeMs / audioMs,
      firstTextAudioMs, endpointAudioMs })
  }
  return { mode, loadMs, hotwordCount: hotwords?.count ?? 0, samples }
}

async function main() {
  if (args[0] === '--worker') {
    if (!modes.includes(args[1])) throw new Error('不支持的回放模式')
    const { manifest, root } = JSON.parse(readFileSync(0, 'utf8'))
    process.stdout.write(JSON.stringify(await replay(args[1], manifest, root)))
    return
  }
  const manifestPath = args[0]
  const outputPath = args[1]
  if (!manifestPath || !outputPath) throw new Error('用法：node --import ./tests/register-source-loader.mjs scripts/replay-voice-recognition.mjs <录音清单.json> <报告.json>')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!manifest.paths || !Array.isArray(manifest.samples) || manifest.samples.length === 0) throw new Error('清单需要 paths 和非空 samples')
  const root = dirname(resolve(manifestPath))
  const results = modes.map((mode) => {
    // ONNX 构造失败可能退出原生进程，各模式放到独立进程，避免吞掉模型错误。
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--worker', mode], {
      input: JSON.stringify({ manifest, root }), encoding: 'utf8', timeout: 60_000, maxBuffer: 4_000_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    if (child.status !== 0) throw new Error(`${mode} 回放失败：${child.stderr.trim() || child.error?.message || child.signal || child.status}`)
    return JSON.parse(child.stdout)
  })
  const report = { createdAt: new Date().toISOString(), audioSource: manifest.audioSource ?? '用户录音',
    note: '只测 ASR 术语命中及解码性能；不把词面命中率当作 LLM 理解或会话定位成功率。离线加速回放不含网络、LLM 和播报延迟。', results }
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(JSON.stringify(results.map((result) => ({ mode: result.mode, loadMs: result.loadMs, hotwordCount: result.hotwordCount,
    matched: result.samples.filter((sample) => sample.termMatch).length, scored: result.samples.filter((sample) => sample.termMatch !== null).length,
    conversationTermsMatched: result.samples.filter((sample) => ['query', 'mixed'].includes(sample.category) && normalize(sample.text).includes('会话')).length,
    conversationSamples: result.samples.filter((sample) => ['query', 'mixed'].includes(sample.category)).length,
    falseCorrections: result.samples.filter((sample) => sample.falseCorrection).length,
    realTimeFactor: result.samples.reduce((sum, sample) => sum + sample.decodeMs, 0) / result.samples.reduce((sum, sample) => sum + sample.audioMs, 0) })), null, 2) + '\n')
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
