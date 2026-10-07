import type { AssistantAttachment } from '../assistant-attachments.js'
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
  /** 执行状态与项目进展分开；idle 只表示当前没有运行中的轮次。 */
  readonly activity?: 'running' | 'idle' | 'unknown'
  readonly sourceVersion?: number
  readonly indexedVersion?: number
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
  /** 手动索引的结构化 LLM 结果；原始材料保留在 entries，模型提取不覆盖来源状态。 */
  readonly analysis?: AssistantIndexAnalysisRun
}

/** 证据只能引用同一会话的标题或原始摘录；Host 会核对原文。 */
export interface AssistantIndexEvidence {
  readonly source: 'title' | 'summary'
  readonly quote: string
}

export interface AssistantIndexFact {
  readonly text: string
  readonly evidence: readonly AssistantIndexEvidence[]
}

export interface AssistantNextAction {
  readonly action: string
  /** recorded 来自已有明确任务，suggested 只是模型建议，尚未安排或执行。 */
  readonly kind: 'recorded' | 'suggested'
  readonly priority: 'high' | 'normal' | 'low'
  readonly reason: string
  readonly evidence: readonly AssistantIndexEvidence[]
}

/** 身份、运行状态和更新时间由 Host 填入，模型只提取语义信息。 */
export interface AssistantSessionAnalysis {
  readonly hostId: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly workspaceName: string
  readonly title: string | null
  readonly sourceStatus: AssistantSessionStatus | 'unknown'
  readonly updatedAt: number | null
  readonly material: 'excerpt' | 'unavailable'
  readonly objective: AssistantIndexFact | null
  readonly progress: readonly AssistantIndexFact[]
  readonly blockers: readonly AssistantIndexFact[]
  readonly pendingTasks: readonly AssistantIndexFact[]
  readonly nextActions: readonly AssistantNextAction[]
  readonly openQuestions: readonly string[]
}

/** 内部索引供助理检索；口语播报是独立输出，不改变此结构。 */
export interface AssistantStructuredIndex {
  readonly schemaVersion: 1
  readonly generation: number
  readonly sessions: readonly AssistantSessionAnalysis[]
}

export interface AssistantIndexAnalysisRun extends AssistantChatRun {
  /** 只包含校验成功的会话，批次未完成或失败时也保留已完成项。 */
  readonly result?: AssistantStructuredIndex
  readonly tasks?: readonly AssistantSessionIndexTask[]
}

/** 每个会话独立调用模型、计时与取消，排队不计入该会话的模型超时。 */
export interface AssistantSessionIndexTask {
  readonly requestId: string
  readonly hostId: string
  readonly sessionId: string
  readonly title: string | null
  readonly workspaceName: string
  readonly state: AssistantChatRun['state'] | 'queued' | 'deferred'
  readonly sourceVersion?: number
  readonly reused?: boolean
  readonly text: string
  readonly error: string | null
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly thinking: 'disabled' | 'provider-default' | null
}

export type AssistantIndexAnalysisRecord = Omit<AssistantIndexAnalysisRun, 'text' | 'requestId' | 'result' | 'tasks'> & {
  readonly tasks?: readonly Omit<AssistantSessionIndexTask, 'text'>[]
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

/** 调试页只返回工作区元数据与受管索引，不暴露整个设置文档或归档正文。 */
export interface AssistantDebugSnapshot {
  readonly capturedAt: number
  readonly index: AssistantIndexSnapshot
  readonly summary: {
    readonly groups: Readonly<Record<AssistantSummaryCategory, readonly SessionIndexEntry[]>>
    readonly unreadableCount: number
    readonly speechText: string
  }
  readonly workspaces: readonly {
    readonly workspaceId: string
    readonly name: string
    readonly path: string | null
  }[]
  readonly modelId: string
  readonly warnings: readonly string[]
  /** 当前范围内的会话元数据；打开面板不会读取正文或自动执行索引。 */
  readonly scopeSessions: readonly SessionIndexEntry[]
  readonly indexState: 'not-built' | 'ready' | 'stale' | 'building' | 'incomplete'
  readonly indexedAt: number | null
  readonly records: readonly AssistantIndexRun[]
  readonly services: {
    readonly workspaceList: boolean
    readonly sessionList: boolean
    readonly summaryRead: boolean
    readonly taskDispatch: boolean
    readonly remoteGateway: boolean
  }
}

/** 每次真实索引的记录，保留最近 30 次；不包含会话正文。 */
export interface AssistantIndexRun {
  readonly id: string
  readonly trigger: 'automatic' | 'manual'
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly durationMs: number | null
  readonly state: 'running' | 'completed' | 'failed'
  readonly workspaceIds: readonly string[]
  readonly generation: number | null
  readonly included: number
  readonly excluded: number
  readonly unreadable: number
  readonly warnings: readonly string[]
  readonly error: string | null
  /** 只保存总结调用的状态与模型，不在运行记录中保存生成正文。 */
  readonly analysis?: AssistantIndexAnalysisRecord
  readonly sessions: readonly {
    readonly sessionId: string
    readonly title: string | null
    readonly workspaceName: string
    readonly result: 'read' | 'empty' | 'failed'
    readonly error: string | null
  }[]
}

export interface AssistantChatModel {
  readonly provider: string
  readonly model: string
  readonly label: string
}

export interface AssistantChatCatalog {
  readonly models: readonly AssistantChatModel[]
  readonly default: AssistantChatModel | null
  readonly errors: readonly string[]
}

export interface AssistantChatMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly attachments?: readonly AssistantAttachment[]
}

/** 正式助理只有一份连续对话，输入来源不改变消息的归属。 */
export interface AssistantConversationMessage extends AssistantChatMessage {
  readonly id: string
  readonly source: 'text' | 'voice'
  readonly createdAt: number
  readonly voiceSessionId?: string
  readonly toolCalls?: readonly AssistantToolCall[]
  /** 挂断时保留已经显示的残句，不能把它宣称为完整回答。 */
  readonly interrupted?: boolean
}

/** 来自实际工具执行事件；只保存有界、已去除凭据的参数和结果摘要。 */
export interface AssistantToolCall {
  readonly id: string
  readonly name: string
  readonly kind: 'workspace' | 'web-search' | 'attachment'
  readonly state: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly arguments: string
  readonly result: string
}

/** 通话记录独立于模型压缩上下文；挂断后的内容仍可回看，不存储原始录音。 */
export interface AssistantVoiceSession {
  readonly id: string
  readonly startedAt: number
  readonly endedAt: number | null
  readonly messages: readonly AssistantConversationMessage[]
}

export interface AssistantConversationSnapshot {
  readonly revision: number
  readonly summary: string
  readonly messages: readonly AssistantConversationMessage[]
  readonly active: AssistantChatRun | null
  readonly pendingMessage: AssistantConversationMessage | null
  readonly compressing: boolean
  readonly error: string | null
  readonly voiceSessions?: readonly AssistantVoiceSession[]
}

export interface AssistantLifecycleSnapshot {
  readonly profile: import('./config.js').AssistantProfileSettings
  readonly conversation: AssistantConversationSnapshot
}

/** 对话独立于语音和项目会话；仅依据明确的索引版本回答。 */
export interface AssistantChatRun {
  readonly requestId: string
  readonly provider: string
  readonly model: string
  readonly generation: number
  readonly state: 'running' | 'completed' | 'failed' | 'cancelled'
  readonly text: string
  readonly error: string | null
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly toolCalls?: readonly AssistantToolCall[]
}

/** 共享层只保留范围状态的结构，不依赖 Host 实现。 */
export type AssistantScopeStateSnapshot =
  | { readonly status: 'empty'; readonly reason: 'no-managed-workspaces'; readonly message: '尚未选择任何工作区' }
  | { readonly status: 'ready'; readonly managedWorkspaceIds: readonly string[] }
