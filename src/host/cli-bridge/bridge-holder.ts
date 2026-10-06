/**
 * 外部 CLI 子代理托管桥接的运行时句柄。
 *
 * Host 装配桥接服务后写入；驱动在拼参数/环境时读取。运行时不保存任何凭据到
 * 磁盘：token 与端口只存在于当前进程，并通过注入通道下发给外部 CLI 子进程。
 */

/** 一次被桥接接管的子代理调用结果，供驱动把 hook_blocked 投影为真实状态。 */
export interface SubagentBridgeRedirect {
  readonly childSessionId: string
  readonly ok: boolean
  /** 后台派发只表示已创建；必须保留 running，不能伪装成 completed。 */
  readonly completed?: boolean | undefined
  readonly status?: 'running' | 'completed' | 'failed' | 'interrupted' | undefined
  readonly toolCalls: number
}

export interface SubagentBridgeRuntime {
  readonly baseUrl: string
  readonly token: string
  /** 记录“某个工具调用已由 DSH 原生子代理完成”；按 toolCallId 去重。 */
  recordRedirect(sessionId: string, toolCallId: string, redirect: SubagentBridgeRedirect): void
  /** 取出并清理重定向记录；同一 toolCallId 只消费一次。 */
  consumeRedirect(sessionId: string, toolCallId: string): SubagentBridgeRedirect | undefined
}

const REDIRECT_TTL_MS = 30 * 60_000
const MAX_REDIRECTS = 1024

let current: SubagentBridgeRuntime | undefined

export function setSubagentBridge(runtime: SubagentBridgeRuntime | undefined): void {
  current = runtime
}

export function getSubagentBridge(): SubagentBridgeRuntime | undefined {
  return current
}

export function createSubagentBridgeRuntime(options: { readonly baseUrl: string; readonly token: string }): SubagentBridgeRuntime {
  const redirects = new Map<string, { readonly redirect: SubagentBridgeRedirect; readonly expiresAt: number }>()
  const keyOf = (sessionId: string, toolCallId: string): string => `${sessionId}\u0000${toolCallId}`
  const prune = (now: number): void => {
    for (const [key, entry] of redirects) {
      if (entry.expiresAt <= now) redirects.delete(key)
    }
    if (redirects.size > MAX_REDIRECTS) {
      for (const key of [...redirects.keys()].slice(0, redirects.size - MAX_REDIRECTS)) redirects.delete(key)
    }
  }
  return {
    baseUrl: options.baseUrl,
    token: options.token,
    recordRedirect(sessionId, toolCallId, redirect) {
      if (sessionId === '' || toolCallId === '') return
      const now = Date.now()
      prune(now)
      redirects.set(keyOf(sessionId, toolCallId), { redirect, expiresAt: now + REDIRECT_TTL_MS })
    },
    consumeRedirect(sessionId, toolCallId) {
      if (sessionId === '' || toolCallId === '') return undefined
      const key = keyOf(sessionId, toolCallId)
      const entry = redirects.get(key)
      if (entry === undefined) return undefined
      redirects.delete(key)
      return entry.expiresAt <= Date.now() ? undefined : entry.redirect
    },
  }
}
