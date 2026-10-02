import type { CodingNsWebTerminals, WebTerminalInfo } from './model.js'
import { debugInfo, debugWarn } from '../../shared/debug.js'

/** Sidebar 记录的最小结构，避免恢复逻辑绑定某个 DSH 版本的类型包。 */
export interface TerminalSidebarTab {
  readonly id: string
  readonly kind: string
  /** DSH TabRecord 的稳定内容地址；旧版 tabsIn 可能没有该字段。 */
  readonly contentId?: string
}

interface TerminalNavigationSnapshot {
  readonly params?: unknown
}

interface TerminalOccurrence {
  readonly navigation: {
    getSnapshot(): TerminalNavigationSnapshot
  }
}

export interface TerminalSidebarMountedSource {
  readonly getSnapshot: () => string | undefined
  readonly subscribe: (listener: () => void) => () => void
}

export interface TerminalSidebarRecoveryPort {
  readonly tabsIn?: (sessionId: string) => readonly TerminalSidebarTab[]
  readonly openTabs?: {
    getSnapshot(): readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[]
    subscribe?: (listener: () => void) => () => void
  }
  readonly mounted?: TerminalSidebarMountedSource
  readonly openTabIn?: (sessionId: string, kind: string, options?: { readonly params?: unknown }) => void
  /** 通过 Sidebar 自己的关闭流程移除指定会话中的标签。 */
  readonly closeIn?: (sessionId: string, tabId: string) => void
  readonly tabDomain?: {
    occurrence(sessionId: string, tab: { readonly id: string }): TerminalOccurrence
  }
}

export interface TerminalSessionRecovery {
  ensure(sessionId: string): Promise<readonly WebTerminalInfo[]>
}

/**
 * 将 Host 已存在的终端补回当前 DSH 会话的 Sidebar。
 *
 * DSH 的布局和标签身份以 sessionId 为存储边界，所以工作区共享只解决
 * Host 终端身份，不能替新会话创建 Sidebar 标签。这里把两个生命周期接起来。
 */
export function createTerminalSessionRecovery(
  webTerminals: Pick<CodingNsWebTerminals, 'recover'>,
  sidebar: TerminalSidebarRecoveryPort,
  terminalKind: string,
): TerminalSessionRecovery {
  const pending = new Map<string, Promise<readonly WebTerminalInfo[]>>()

  const ensure = (sessionId: string): Promise<readonly WebTerminalInfo[]> => {
    const normalized = sessionId.trim()
    if (normalized === '') return Promise.resolve([])
    const current = pending.get(normalized)
    if (current !== undefined) return current
    debugInfo('codingns4dsh: client terminal sidebar recovery begin', { sessionId: normalized })
    const task = recoverAndOpen(normalized)
      .catch((cause: unknown) => {
        debugWarn('codingns4dsh: client terminal sidebar recovery failed', { sessionId: normalized, error: messageOf(cause) })
        throw cause
      })
      .finally(() => pending.delete(normalized))
    pending.set(normalized, task)
    return task
  }

  const recoverAndOpen = async (sessionId: string): Promise<readonly WebTerminalInfo[]> => {
    const terminals = await webTerminals.recover(sessionId)
    const existing = readTabs(sidebar, sessionId)
    debugInfo('codingns4dsh: client terminal sidebar recovery listed', {
      sessionId,
      terminalIds: terminals.map((terminal) => terminal.id),
      existingTabs: existing.map((tab) => ({ id: tab.id, kind: tab.kind })),
    })
    const terminalTabs = existing.filter((tab) => tab.kind === terminalKind)
    if (terminals.length === 0) {
      // 聚合页代表整个工作区；库存为空时移除页签本身，不再按旧 terminalId
      // 判断某个标签是否残留。新的关闭回调只负责布局移除，不会调用 Host close。
      for (const tab of terminalTabs) {
        sidebar.closeIn?.(sessionId, tab.id)
        debugInfo('codingns4dsh: client terminal aggregate tab removed for empty inventory', { sessionId, tabId: tab.id })
      }
      return terminals
    }
    if (terminalTabs.length === 0) {
      if (typeof sidebar.openTabIn !== 'function') {
        debugWarn('codingns4dsh: client terminal aggregate recovery unavailable', { sessionId, reason: 'openTabIn-undefined' })
        return terminals
      }
      sidebar.openTabIn(sessionId, terminalKind)
      debugInfo('codingns4dsh: client terminal aggregate tab opened', { sessionId, terminalCount: terminals.length })
      return terminals
    }
    // 升级迁移：旧版本可能为每个 Host 终端保存一个 Sidebar 标签。保留一个
    // 作为聚合页，其余只走 Sidebar 关闭流程，绝不按旧导航参数关闭 Host。
    for (const tab of terminalTabs.slice(1)) {
      sidebar.closeIn?.(sessionId, tab.id)
      debugInfo('codingns4dsh: client terminal legacy tab collapsed', { sessionId, tabId: tab.id })
    }
    return terminals
  }

  return { ensure }
}

function readTabs(sidebar: TerminalSidebarRecoveryPort, sessionId: string): readonly TerminalSidebarTab[] {
  if (typeof sidebar.tabsIn === 'function') {
    try { return sidebar.tabsIn(sessionId) }
    catch { return [] }
  }
  return readOpenTabs(sidebar)
    .filter((tab) => tab.sessionId === sessionId)
    .map((tab) => ({ id: tab.tabId, kind: tab.kind }))
}

function readOpenTabs(sidebar: TerminalSidebarRecoveryPort): readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[] {
  try { return sidebar.openTabs?.getSnapshot() ?? [] }
  catch { return [] }
}

function messageOf(value: unknown): string { return value instanceof Error ? value.message : String(value) }
