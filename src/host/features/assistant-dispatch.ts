import { getAssistantScopeRejection, type AssistantScope, type AssistantScopeRejection } from './assistant-scope.js'
import type { AssistantDispatchMode, AssistantTargetRef } from './assistant-intent.js'
import type { SessionIndexEntry } from '../../shared/contracts/assistant.js'

export interface AssistantPromptRequest {
  readonly requestId: string
  readonly sessionId: string
  readonly mode: AssistantDispatchMode
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }]
  readonly hostId?: string
}

export interface AssistantDispatchContext {
  readonly scope: AssistantScope
  readonly archivedSessionIds: ReadonlySet<string> | readonly string[]
  readonly indexGeneration: number
  readonly entries: readonly SessionIndexEntry[]
}

export type AssistantDispatchResult =
  | { readonly ok: true; readonly requestId: string; readonly target: AssistantTargetRef; readonly mode: AssistantDispatchMode }
  | { readonly ok: false; readonly code: 'invalid-request' | 'stale-target' | 'target-not-found' | 'scope-rejected'; readonly message: string; readonly rejection?: AssistantScopeRejection }

export type AssistantPrompt = (request: AssistantPromptRequest, signal?: AbortSignal) => unknown | Promise<unknown>

/** 派发前再次校验当前索引代次、范围和归档状态；不自动取消归档。 */
export class AssistantDispatcher {
  private readonly sentRequestIds = new Map<string, AssistantDispatchResult>()
  private readonly pendingRequestIds = new Map<string, Promise<AssistantDispatchResult>>()

  constructor(private readonly prompt: AssistantPrompt) {}

  async dispatch(
    request: { readonly requestId: string; readonly target: AssistantTargetRef; readonly mode: AssistantDispatchMode; readonly task: string },
    context: AssistantDispatchContext,
    signal?: AbortSignal,
  ): Promise<AssistantDispatchResult> {
    const requestId = request.requestId.trim()
    const task = request.task.trim()
    if (requestId === '' || task === '') return { ok: false, code: 'invalid-request', message: '请求标识和任务内容不能为空' }
    if (request.target.indexGeneration !== context.indexGeneration) return { ok: false, code: 'stale-target', message: '索引已更新，请重新确认目标会话' }
    const entry = context.entries.find((candidate) => candidate.sessionId === request.target.sessionId && candidate.hostId === request.target.hostId)
    if (entry === undefined) return { ok: false, code: 'target-not-found', message: '目标会话不存在或已退出索引' }
    if (entry.workspaceId !== request.target.workspaceId || entry.hostId !== request.target.hostId) {
      const mismatch = getAssistantScopeRejection(context.scope, { workspaceId: request.target.workspaceId, sessionId: request.target.sessionId }, context.archivedSessionIds)
      return { ok: false, code: 'scope-rejected', message: mismatch?.message ?? '目标会话来源已变化', ...(mismatch === null ? {} : { rejection: mismatch }) }
    }
    const rejection = getAssistantScopeRejection(context.scope, { workspaceId: entry.workspaceId, sessionId: entry.sessionId }, context.archivedSessionIds)
    if (rejection !== null) return { ok: false, code: 'scope-rejected', message: rejection.message, rejection }
    const sent = this.sentRequestIds.get(requestId)
    if (sent !== undefined) return sent
    const pending = this.pendingRequestIds.get(requestId)
    if (pending !== undefined) return await pending
    const operation = (async (): Promise<AssistantDispatchResult> => {
      signal?.throwIfAborted()
      await this.prompt({ requestId, sessionId: request.target.sessionId, mode: request.mode, content: [{ type: 'text', text: task }], hostId: request.target.hostId }, signal)
      const result: AssistantDispatchResult = { ok: true, requestId, target: request.target, mode: request.mode }
      this.sentRequestIds.set(requestId, result)
      return result
    })()
    this.pendingRequestIds.set(requestId, operation)
    try {
      return await operation
    } finally {
      if (this.pendingRequestIds.get(requestId) === operation) this.pendingRequestIds.delete(requestId)
    }
  }
}
