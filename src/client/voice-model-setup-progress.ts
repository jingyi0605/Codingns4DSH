import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { AssistantVoiceModelProgress } from '../shared/voice-models.js'
import type { CodingNsRpcClient } from './features/types.js'

/** 复用页面 RPC 查询下载状态；每次查询返回后再安排下一次，避免请求积压。 */
export function watchVoiceModelSetupProgress(
  rpc: CodingNsRpcClient,
  request: { readonly modelId: string; readonly requestId: string },
  onProgress: (progress: AssistantVoiceModelProgress) => void,
): () => void {
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const controller = new AbortController()
  const poll = async (): Promise<void> => {
    try {
      const result = await rpc.call(CODINGNS_RPC_CHANNEL, 'assistant/voice/setup-progress', request, controller.signal)
      const progress = result.ok ? result.value as AssistantVoiceModelProgress | null : null
      if (active && progress != null && progress.modelId === request.modelId) onProgress(progress)
    } catch {
      // 查询暂时失败时保留最后的进度；初始化请求本身负责报告最终错误。
    }
    if (active) timer = setTimeout(() => void poll(), 300)
  }
  void poll()
  return () => {
    active = false
    clearTimeout(timer)
    controller.abort()
  }
}
