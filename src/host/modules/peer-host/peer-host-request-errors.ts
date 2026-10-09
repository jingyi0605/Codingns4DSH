/** 调用方取消与请求超时分开处理：超时仍然属于需要诊断的真实失败。 */
export function isPeerHostRequestCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (errorName(error) === 'TimeoutError' || errorName(signal?.reason) === 'TimeoutError') return false
  return errorName(error) === 'AbortError' || signal?.aborted === true
}

/** 关闭流时允许自定义 reason，但向上传播时始终保留标准 AbortError 语义。 */
export function throwIfPeerHostRequestAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (errorName(signal.reason) === 'TimeoutError' || errorName(signal.reason) === 'AbortError') throw signal.reason
  const error = new Error('PeerHost 请求已取消', { cause: signal.reason })
  error.name = 'AbortError'
  throw error
}

function errorName(error: unknown): unknown {
  return error !== null && typeof error === 'object' ? (error as { name?: unknown }).name : undefined
}
