import type { CodingNsWebTerminals, WebTerminalInfo } from './model.js'
import { debugInfo, debugWarn } from '../../shared/debug.js'

/** Sidebar 记录的最小结构，避免恢复逻辑绑定某个 DSH 版本的类型包。 */
export interface TerminalSidebarTab {
  readonly id: string
  readonly kind: string
  /** DSH TabRecord 的稳定内容地址；旧版 tabsIn 可能没有该字段。 */
  readonly contentId?: string
  /** 新建入口写入的导航意图；只有仍处于创建中的页签需要恢复清理保护。 */
  readonly autoCreate?: boolean
}

interface TerminalNavigationSnapshot {
  readonly params?: unknown
  readonly revision?: number
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
  /**
   * 使指定会话中尚未完成的恢复请求失效。
   *
   * 工作区库存由多个会话共享。某个会话关闭终端后，其他会话收到库存
   * 变更通知时必须丢弃旧的 pending；否则旧 list 响应会把残留页签重新
   * 投影回来。该方法只取消 Client 侧的投影，不会关闭 Host 终端。
   */
  invalidate(sessionId: string): void
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
  isAutoCreatePending?: (sessionId: string) => boolean,
): TerminalSessionRecovery {
  const pending = new Map<string, Promise<readonly WebTerminalInfo[]>>()
  /** 每次失效递增；旧恢复完成后不得再改动 Sidebar。 */
  const generations = new Map<string, number>()
  /** 用户主动关闭聚合页签后，在用户再次打开前禁止自动补回。 */
  const dismissed = new Set<string>()
  /** 上一次观察到的终端页签状态，用于识别用户关闭动作。 */
  const lastTerminalTabPresence = new Map<string, boolean>()

  const ensure = (sessionId: string): Promise<readonly WebTerminalInfo[]> => {
    const normalized = sessionId.trim()
    if (normalized === '') return Promise.resolve([])
    const current = pending.get(normalized)
    if (current !== undefined) return current
    const generation = generations.get(normalized) ?? 0
    debugInfo('codingns4dsh: client terminal sidebar recovery begin', { sessionId: normalized })
    let task: Promise<readonly WebTerminalInfo[]>
    task = recoverAndOpen(normalized, generation)
      .catch((cause: unknown) => {
        debugWarn('codingns4dsh: client terminal sidebar recovery failed', { sessionId: normalized, error: messageOf(cause) })
        throw cause
      })
      .finally(() => {
        // 失效后可能已经有新一代恢复请求；旧请求不得把新请求从 pending 中删掉。
        if (pending.get(normalized) === task) pending.delete(normalized)
      })
    pending.set(normalized, task)
    return task
  }

  const invalidate = (sessionId: string): void => {
    const normalized = sessionId.trim()
    if (normalized === '') return
    generations.set(normalized, (generations.get(normalized) ?? 0) + 1)
    pending.delete(normalized)
    debugInfo('codingns4dsh: client terminal sidebar recovery invalidated', { sessionId: normalized })
  }

  const recoverAndOpen = async (sessionId: string, generation: number): Promise<readonly WebTerminalInfo[]> => {
    // 先记录恢复开始时的页签快照。recover() 期间用户可能刚点击“终端”，
    // 新页签会在 Host 列表返回前出现；这类页签不是残留，不能被空库存清理掉。
    const initialTabs = readTabs(sidebar, sessionId)
    const initialTerminalTabIds = new Set(initialTabs.filter((tab) => tab.kind === terminalKind).map((tab) => tab.id))
    const hasInitialTerminalTab = initialTerminalTabIds.size > 0
    if (lastTerminalTabPresence.get(sessionId) === true && !hasInitialTerminalTab) {
      dismissed.add(sessionId)
      debugInfo('codingns4dsh: client terminal aggregate tab dismissed by user', { sessionId })
    }
    lastTerminalTabPresence.set(sessionId, hasInitialTerminalTab)
    const terminals = await webTerminals.recover(sessionId)
    // 该请求可能在另一个会话关闭终端后才返回。结果仍交给调用方完成
    // 自己的请求收敛，但禁止旧结果操作 Sidebar，避免重新打开残留页签。
    if ((generations.get(sessionId) ?? 0) !== generation) {
      debugInfo('codingns4dsh: client terminal sidebar recovery stale', {
        sessionId,
        terminalIds: terminals.map((terminal) => terminal.id),
      })
      return terminals
    }
    const existing = readTabs(sidebar, sessionId)
    debugInfo('codingns4dsh: client terminal sidebar recovery listed', {
      sessionId,
      terminalIds: terminals.map((terminal) => terminal.id),
      existingTabs: existing.map((tab) => ({ id: tab.id, kind: tab.kind })),
    })
    const terminalTabs = existing.filter((tab) => tab.kind === terminalKind)
    // recover() 等待期间用户可能关闭了原有聚合页签；此时开始快照有页签、
    // 完成快照没有页签，必须按主动关闭处理，不能把它误判成新会话缺页签。
    if (initialTerminalTabIds.size > 0 && terminalTabs.length === 0) {
      dismissed.add(sessionId)
      debugInfo('codingns4dsh: client terminal aggregate tab dismissed during recovery', { sessionId })
    }
    if (terminals.length === 0) {
      // 聚合页代表整个工作区；库存为空时移除页签本身，不再按旧 terminalId
      // 判断某个标签是否残留。新的关闭回调只负责布局移除，不会调用 Host close。
      for (const tab of terminalTabs) {
        // 用户刚打开的聚合页可能还在等待首个 create 请求；保留它让 TerminalBody
        // 完成创建。只有当前会话仍有本地创建意图时才保留带 autoCreate 的页签；
        // 创建成功或失败超时后，旧导航参数不能永久阻止空库存清理。
        if (!initialTerminalTabIds.has(tab.id) || (tab.autoCreate === true && isAutoCreatePending?.(sessionId) === true)) continue
        sidebar.closeIn?.(sessionId, tab.id)
        debugInfo('codingns4dsh: client terminal aggregate tab removed for empty inventory', { sessionId, tabId: tab.id })
      }
      dismissed.delete(sessionId)
      lastTerminalTabPresence.set(sessionId, false)
      return terminals
    }
    if (terminalTabs.length === 0) {
      if (dismissed.has(sessionId)) {
        debugInfo('codingns4dsh: client terminal aggregate tab recovery suppressed', { sessionId, terminalCount: terminals.length })
        return terminals
      }
      if (typeof sidebar.openTabIn !== 'function') {
        debugWarn('codingns4dsh: client terminal aggregate recovery unavailable', { sessionId, reason: 'openTabIn-undefined' })
        return terminals
      }
      sidebar.openTabIn(sessionId, terminalKind)
      lastTerminalTabPresence.set(sessionId, true)
      debugInfo('codingns4dsh: client terminal aggregate tab opened', { sessionId, terminalCount: terminals.length })
      return terminals
    }
    dismissed.delete(sessionId)
    lastTerminalTabPresence.set(sessionId, true)
    // 升级迁移：旧版本可能为每个 Host 终端保存一个 Sidebar 标签。保留一个
    // 作为聚合页，其余只走 Sidebar 关闭流程，绝不按旧导航参数关闭 Host。
    for (const tab of terminalTabs.slice(1)) {
      sidebar.closeIn?.(sessionId, tab.id)
      debugInfo('codingns4dsh: client terminal legacy tab collapsed', { sessionId, tabId: tab.id })
    }
    return terminals
  }

  return { ensure, invalidate }
}

function readTabs(sidebar: TerminalSidebarRecoveryPort, sessionId: string): readonly TerminalSidebarTab[] {
  if (typeof sidebar.tabsIn === 'function') {
    try { return sidebar.tabsIn(sessionId).map((tab) => readTab(sidebar, sessionId, tab)) }
    catch { return [] }
  }
  return readOpenTabs(sidebar)
    .filter((tab) => tab.sessionId === sessionId)
    .map((tab) => readTab(sidebar, sessionId, { id: tab.tabId, kind: tab.kind }))
}

function readTab(sidebar: TerminalSidebarRecoveryPort, sessionId: string, tab: TerminalSidebarTab): TerminalSidebarTab {
  if (sidebar.tabDomain === undefined) return tab
  try {
    const snapshot = sidebar.tabDomain.occurrence(sessionId, { id: tab.id }).navigation.getSnapshot()
    const params = snapshot.params
    return {
      ...tab,
      autoCreate: isRecord(params) && params.autoCreate === true,
    }
  } catch {
    return tab
  }
}

function readOpenTabs(sidebar: TerminalSidebarRecoveryPort): readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[] {
  try { return sidebar.openTabs?.getSnapshot() ?? [] }
  catch { return [] }
}

function messageOf(value: unknown): string { return value instanceof Error ? value.message : String(value) }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
