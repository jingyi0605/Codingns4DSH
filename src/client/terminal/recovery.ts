import type { CodingNsWebTerminals, WebTerminalInfo } from './model.js'
import { debugInfo, debugWarn } from '../../shared/debug.js'

/** Sidebar 记录的最小结构，避免恢复逻辑绑定某个 DSH 版本的类型包。 */
export interface TerminalSidebarTab {
  readonly id: string
  readonly kind: string
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
    const opened = new Set<string>()
    const available = new Set(terminals.map((terminal) => terminal.id))
    /**
     * Host 列表为空时不能做任何"残留标签"清理。
     *
     * 用户点"新建终端"后，Sidebar 标签会立刻出现并触发 TerminalCleanup 的恢复，
     * 而 Host 侧的 create 还在进行中、list 暂时为空。此刻把"不在列表里"当作残留
     * 证据就会把刚建好的标签直接关掉，右侧栏随即退回"开始"引导页。
     */
    const canPrune = terminals.length > 0
    for (const tab of existing) {
      if (tab.kind !== terminalKind) continue
      const id = terminalIdOf(sidebar, sessionId, tab)
      if (id === undefined) {
        // 没有 terminalId 的标签可能是旧版残留，也可能是刚点开、参数尚未写入的
        // 新标签；两者无法区分，而误关活终端远比残留一个标签严重，因此一律保留。
        for (const terminal of terminals) opened.add(terminal.id)
        debugInfo('codingns4dsh: client terminal sidebar recovery legacy tab', { sessionId, tabId: tab.id })
      } else {
        if (canPrune && !available.has(id)) {
          // Host 已经关闭该终端时，旧 Sidebar 标签只是残留记录，必须走
          // Sidebar 的正式关闭路径，才能同步更新布局和标签生命周期。
          sidebar.closeIn?.(sessionId, tab.id)
          debugInfo('codingns4dsh: client terminal sidebar recovery removed stale tab', { sessionId, tabId: tab.id, terminalId: id })
          continue
        }
        opened.add(id)
      }
    }
    for (const terminal of terminals) {
      if (opened.has(terminal.id)) {
        debugInfo('codingns4dsh: client terminal sidebar recovery skip existing', { sessionId, terminalId: terminal.id })
        continue
      }
      if (typeof sidebar.openTabIn !== 'function') {
        debugWarn('codingns4dsh: client terminal sidebar recovery unavailable', { sessionId, terminalId: terminal.id, reason: 'openTabIn-undefined' })
        continue
      }
      sidebar.openTabIn(sessionId, terminalKind, { params: { terminalId: terminal.id } })
      debugInfo('codingns4dsh: client terminal sidebar recovery opened', { sessionId, terminalId: terminal.id })
      opened.add(terminal.id)
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

function terminalIdOf(sidebar: TerminalSidebarRecoveryPort, sessionId: string, tab: TerminalSidebarTab): string | undefined {
  try {
    const params = sidebar.tabDomain?.occurrence(sessionId, tab).navigation.getSnapshot().params
    if (typeof params !== 'object' || params === null) return undefined
    const terminalId = (params as { readonly terminalId?: unknown }).terminalId
    return typeof terminalId === 'string' && terminalId.trim() !== '' ? terminalId : undefined
  } catch {
    return undefined
  }
}

function messageOf(value: unknown): string { return value instanceof Error ? value.message : String(value) }
