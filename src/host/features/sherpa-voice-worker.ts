import { parentPort, workerData } from 'node:worker_threads'
import { SherpaVoiceRuntime, type SherpaVoiceRuntimeOptions } from './sherpa-voice-runtime.js'
import type { VoicePcmFrame } from '../../shared/contracts/voice-runtime.js'
import { subscribeVoiceDiagnostics } from '../../shared/voice-diagnostics.js'

/** 原生 ONNX 构造、解码和合成都只在此线程运行，Host 仅处理小型控制消息。 */
export type SherpaWorkerCommand =
  | { readonly id: number; readonly action: 'start' | 'stop' | 'interrupt'; readonly epoch: number }
  | { readonly id: number; readonly action: 'pcm'; readonly epoch: number; readonly frame: VoicePcmFrame }
  | { readonly id: number; readonly action: 'speak'; readonly epoch: number; readonly text: string }

if (parentPort !== null) {
  const port = parentPort
  const runtime = new SherpaVoiceRuntime(workerData as SherpaVoiceRuntimeOptions)
  subscribeVoiceDiagnostics((record) => port.postMessage({ type: 'diagnostic', record }))
  runtime.subscribe((event) => port.postMessage({ type: 'event', event, capabilities: runtime.capabilities }))
  let tail = Promise.resolve()
  port.on('message', (command: SherpaWorkerCommand) => {
    // start/load 含异步文件读取；顺序处理保证 stop 不会被迟到的模型加载覆盖。
    tail = tail.then(async () => {
      try {
        runtime.setEpoch(command.epoch)
        switch (command.action) {
          case 'start': await runtime.start(); break
          case 'stop': await runtime.stop(); break
          case 'interrupt': runtime.interrupt(); break
          case 'pcm': runtime.sendPcm(command.frame, command.epoch); break
          case 'speak': runtime.speak(command.text, command.epoch); break
        }
        port.postMessage({ type: 'result', id: command.id, capabilities: runtime.capabilities })
      } catch (error) {
        port.postMessage({ type: 'result', id: command.id, error: error instanceof Error ? error.message : String(error), capabilities: runtime.capabilities })
      }
    })
  })
}
