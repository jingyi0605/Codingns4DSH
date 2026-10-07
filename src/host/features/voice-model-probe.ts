import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import type { AssistantVoiceModelPaths } from '../../shared/voice-models.js'
import { createSherpaRecognizerConfig } from './sherpa-voice-runtime.js'

const PROBE_OK = 'CODINGNS_VOICE_MODEL_PROBE_OK'
// 原生 ONNX 加载失败可能直接终止进程；验证必须在独立子进程中执行。
const PROBE_SCRIPT = `
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
try {
  const imported = await import(pathToFileURL(process.argv[1]).href);
  const module = imported.default ?? imported;
  if (typeof module.OnlineRecognizer !== 'function') throw new Error('Sherpa-ONNX Node 未导出 OnlineRecognizer');
  const config = JSON.parse(readFileSync(0, 'utf8'));
  const recognizer = new module.OnlineRecognizer(config);
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: config.featConfig.sampleRate, samples: new Float32Array(config.featConfig.sampleRate * 2) });
  stream.inputFinished();
  let decoded = 0;
  while (recognizer.isReady(stream)) {
    if (++decoded > 500) throw new Error('模型验证解码未能正常结束');
    recognizer.decode(stream);
  }
  if (decoded === 0) throw new Error('模型无法执行识别解码');
  const result = recognizer.getResult(stream);
  if (typeof result?.text !== 'string') throw new Error('模型没有返回有效的识别结果');
  process.stdout.write('${PROBE_OK}');
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`

/** 加载四个模型文件并执行静音识别，不启动麦克风，也不占用全局语音租约。 */
export async function probeAssistantVoiceModel(paths: AssistantVoiceModelPaths, options: {
  readonly modulePath?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
} = {}): Promise<void> {
  options.signal?.throwIfAborted()
  let modulePath: string
  try { modulePath = options.modulePath ?? createRequire(import.meta.url).resolve('sherpa-onnx-node') }
  catch { throw new Error('当前 Host 缺少 Sherpa-ONNX 运行时，无法验证或使用模型') }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', PROBE_SCRIPT, modulePath], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let output = ''
    let errorOutput = ''
    let stopped: string | undefined
    const stop = (reason: string): void => { stopped = reason; child.kill('SIGKILL') }
    const abort = (): void => stop('模型验证已取消')
    const timer = setTimeout(() => stop('模型验证超时，请检查 Host 运行时或重新下载模型'), options.timeoutMs ?? 45_000)
    const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8192) })
    child.stderr.on('data', (chunk: Buffer) => { errorOutput = (errorOutput + chunk.toString()).slice(-8192) })
    child.once('error', (error) => { cleanup(); reject(new Error(`模型验证进程无法启动：${error.message}`)) })
    child.once('close', (code, signal) => {
      cleanup()
      if (stopped !== undefined) { reject(new Error(stopped)); return }
      if (code === 0 && output.includes(PROBE_OK)) { resolve(); return }
      reject(new Error(`模型验证失败：${errorOutput.trim() || `验证进程退出（${signal ?? code}）`}`))
    })
    // 原生模块提前退出时管道可能关闭，最终错误由 close 事件统一报告。
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(createSherpaRecognizerConfig(paths)))
    if (options.signal?.aborted) abort()
  })
}
