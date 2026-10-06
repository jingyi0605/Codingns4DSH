/** 会话等待用户处理的具体类型；它不能从 running 状态推断。 */
export type AssistantWaitingKind = 'approval' | 'question'

export type AssistantSessionStatus = 'waiting' | 'error' | 'running' | 'completed'
export type AssistantSummaryCategory = AssistantSessionStatus

export interface AssistantSummaryOptions {
  readonly scope?: AssistantScopeStateSnapshot
  readonly generation?: number
  readonly maxChars?: number
  readonly maxItemsPerCategory?: number
  /** 摘要读取失败的会话数；大于零时必须在播报中明确提示结果可能不完整。 */
  readonly unreadableCount?: number
}

/** 会话索引中供摘要和意图解析使用的最小事实记录。 */
export interface SessionIndexEntry {
  readonly sessionId: string
  readonly title: string | null
  readonly workspaceId: string
  readonly workspaceName: string
  readonly hostId: string
  readonly running: boolean
  readonly completed: boolean
  /** 原始会话没有可确认状态时保留 unknown，不用布尔默认值猜测。 */
  readonly status?: AssistantSessionStatus | 'unknown'
  readonly error?: boolean
  readonly archived?: boolean
  readonly updatedAt: number | null
  readonly waiting: AssistantWaitingKind | null
  readonly summary?: string | null
}

/** 一次索引构建的不可变快照。 */
export interface AssistantIndexSnapshot {
  readonly generation: number
  readonly entries: readonly SessionIndexEntry[]
  /** 本次索引中摘要内容读取失败的会话数。 */
  readonly unreadableCount: number
  /** 只保留标题与范围元数据，用于解释范围外/归档目标；不含摘要正文。 */
  readonly excludedTargets?: readonly AssistantExcludedTarget[]
  readonly scope: AssistantScopeStateSnapshot
}

export interface AssistantExcludedTarget {
  readonly sessionId: string
  readonly title: string | null
  readonly workspaceId: string
  readonly workspaceName: string
  readonly hostId: string
  readonly archived: boolean
}

export interface AssistantSummarySection {
  readonly category: AssistantSummaryCategory
  readonly entries: readonly SessionIndexEntry[]
  readonly text: string
}

export interface AssistantProgressSummary {
  readonly generation: number
  readonly total: number
  /** 本次摘要未能读取的会话数。 */
  readonly unreadableCount: number
  readonly sections: readonly AssistantSummarySection[]
  readonly speechText: string
}

/** 共享层只保留范围状态的结构，不依赖 Host 实现。 */
export type AssistantScopeStateSnapshot =
  | { readonly status: 'empty'; readonly reason: 'no-managed-workspaces'; readonly message: '尚未选择任何工作区' }
  | { readonly status: 'ready'; readonly managedWorkspaceIds: readonly string[] }
