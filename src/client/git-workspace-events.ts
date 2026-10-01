/** Git 工作区状态变更通知；只在当前页面进程内传递，不改变 Host RPC 契约。 */

export type GitWorkspaceChangedListener = () => void

const listenersByWorkspace = new Map<string, Set<GitWorkspaceChangedListener>>()

/** 订阅一个工作区的 Git 状态变化；返回幂等取消函数。 */
export function subscribeGitWorkspaceChanged(workspaceId: string, listener: GitWorkspaceChangedListener): () => void {
  const normalized = normalizeWorkspaceId(workspaceId)
  if (normalized === '') return () => undefined
  let listeners = listenersByWorkspace.get(normalized)
  if (listeners === undefined) {
    listeners = new Set<GitWorkspaceChangedListener>()
    listenersByWorkspace.set(normalized, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners?.delete(listener)
    if (listeners?.size === 0) listenersByWorkspace.delete(normalized)
  }
}

/** 通知当前页面内订阅者重新读取工作区 Git 状态。 */
export function notifyGitWorkspaceChanged(workspaceId: string): void {
  const normalized = normalizeWorkspaceId(workspaceId)
  const listeners = listenersByWorkspace.get(normalized)
  if (listeners === undefined) return
  for (const listener of [...listeners]) listener()
}

function normalizeWorkspaceId(value: string): string {
  return value.trim()
}
