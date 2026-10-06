import {
  getAssistantScopeRejection,
  type AssistantScope,
  type AssistantScopeRejection,
} from './assistant-scope.js'
import type { SessionIndexEntry } from '../../shared/contracts/assistant.js'
import type { AssistantExcludedTarget } from '../../shared/contracts/assistant.js'

export type AssistantIntentKind = 'summary' | 'dispatch' | 'clarify' | 'chat'
export type AssistantDispatchMode = 'queue' | 'steer'

export interface AssistantTargetRef {
  readonly sessionId: string
  readonly workspaceId: string
  readonly hostId: string
  readonly indexGeneration: number
}

export interface AssistantIntentOptions {
  readonly scope?: AssistantScope
  readonly archivedSessionIds?: ReadonlySet<string> | readonly string[]
  readonly indexGeneration?: number
  readonly excludedTargets?: readonly AssistantExcludedTarget[]
}

export interface AssistantIntent {
  readonly kind: AssistantIntentKind
  readonly text: string
  readonly targetDescription?: string
  readonly task?: string
  readonly mode?: AssistantDispatchMode
  readonly target?: AssistantTargetRef
  readonly candidates?: readonly SessionIndexEntry[]
  readonly reason?: string
  readonly rejection?: AssistantScopeRejection
}

export type AssistantTargetResolution =
  | { readonly status: 'matched'; readonly target: AssistantTargetRef }
  | { readonly status: 'clarify'; readonly reason: string; readonly candidates: readonly SessionIndexEntry[] }
  | { readonly status: 'not-found'; readonly reason: string }
  | { readonly status: 'rejected'; readonly rejection: AssistantScopeRejection }

/** 规则解析只做路由，不调用模型，也不产生派发副作用。 */
export function parseAssistantIntent(
  text: string,
  entries: readonly SessionIndexEntry[],
  options: AssistantIntentOptions = {},
): AssistantIntent {
  const normalized = text.trim()
  if (isSummaryIntent(normalized)) return { kind: 'summary', text: normalized }
  const dispatch = parseDispatch(normalized)
  if (dispatch === null) return { kind: 'chat', text: normalized }

  const resolution = resolveAssistantTarget(dispatch.targetDescription, entries, options)
  if (resolution.status === 'matched') {
    return {
      kind: 'dispatch',
      text: normalized,
      targetDescription: dispatch.targetDescription,
      task: dispatch.task,
      mode: dispatch.mode,
      target: resolution.target,
    }
  }
  if (resolution.status === 'rejected') {
    return {
      kind: 'clarify',
      text: normalized,
      targetDescription: dispatch.targetDescription,
      task: dispatch.task,
      mode: dispatch.mode,
      reason: resolution.rejection.message,
      rejection: resolution.rejection,
    }
  }
  return {
    kind: 'clarify',
    text: normalized,
    targetDescription: dispatch.targetDescription,
    task: dispatch.task,
    mode: dispatch.mode,
    reason: resolution.reason,
    ...(resolution.status === 'clarify' ? { candidates: resolution.candidates } : {}),
  }
}

export function resolveAssistantTarget(
  description: string,
  entries: readonly SessionIndexEntry[],
  options: AssistantIntentOptions = {},
): AssistantTargetResolution {
  const candidates = entries.filter((entry) => entry.archived !== true)
  const query = normalize(description)
  if (query === '') return { status: 'not-found', reason: '未提供目标会话描述' }

  const exact = candidates.filter((entry) => normalize(entry.title ?? '') === query)
  const exactResult = resolveCandidates(exact, options)
  if (exactResult !== null) return exactResult

  const contained = candidates.filter((entry) => normalize(entry.title ?? '').includes(query) || query.includes(normalize(entry.title ?? '')))
  const containedResult = resolveCandidates(contained, options)
  if (containedResult !== null) return containedResult

  const ordinal = resolveOrdinalTarget(description, candidates)
  if (ordinal !== null) {
    const ordinalResult = resolveCandidates(ordinal, options)
    if (ordinalResult !== null) return ordinalResult
  }

  if (/最近|刚刚|刚才|最新/u.test(description)) {
    const sorted = [...candidates].sort((left, right) => (right.updatedAt ?? -Infinity) - (left.updatedAt ?? -Infinity))
    const newestTime = sorted[0]?.updatedAt
    if (newestTime !== undefined && newestTime !== null) {
      const newest = sorted.filter((entry) => entry.updatedAt === newestTime)
      const recentResult = resolveCandidates(newest, options)
      if (recentResult !== null) return recentResult
    }
  }

  const excluded = (options.excludedTargets ?? []).filter((entry) => {
    const title = normalize(entry.title ?? '')
    const sessionId = normalize(entry.sessionId)
    return (title !== '' && (title === query || title.includes(query) || query.includes(title))) || sessionId === query || sessionId.includes(query)
  })
  if (excluded.length === 1) {
    const entry = excluded[0]!
    if (entry.archived) return { status: 'rejected', rejection: { code: 'session-archived', sessionId: entry.sessionId, message: `会话「${entry.title ?? entry.sessionId}」已归档，不在助理索引范围内` } }
    return { status: 'rejected', rejection: { code: 'workspace-outside-scope', workspaceId: entry.workspaceId, message: `工作区「${entry.workspaceName || entry.workspaceId}」不在助理受管范围内` } }
  }

  return { status: 'not-found', reason: `找不到受管范围内的会话「${description}」` }
}

function resolveCandidates(candidates: readonly SessionIndexEntry[], options: AssistantIntentOptions): AssistantTargetResolution | null {
  if (candidates.length === 0) return null
  if (candidates.length > 1) {
    return { status: 'clarify', reason: '目标会话不唯一，请说明工作区或完整标题', candidates }
  }
  const entry = candidates[0]
  if (!entry) return null
  if (options.scope !== undefined) {
    const rejection = getAssistantScopeRejection(options.scope, {
      workspaceId: entry.workspaceId,
      sessionId: entry.sessionId,
    }, options.archivedSessionIds ?? [])
    if (rejection !== null) return { status: 'rejected', rejection }
  }
  return {
    status: 'matched',
    target: {
      sessionId: entry.sessionId,
      workspaceId: entry.workspaceId,
      hostId: entry.hostId,
      indexGeneration: options.indexGeneration ?? 0,
    },
  }
}

function parseDispatch(text: string): { targetDescription: string; task: string; mode: AssistantDispatchMode } | null {
  const match = /^(?:请|请让|让|叫|通知)\s*(.+?)\s*(?:去|来)?\s*(?:做|执行|处理|完成|运行|跑|修复|检查|改)\s*(.+)$/u.exec(text)
    ?? /^(?:帮我|麻烦你|麻烦)\s*(?:把)?\s*(.+?)\s*(?:处理|完成|运行|跑|修复|检查|改)\s*(.+?)(?:一下)?$/u.exec(text)
    ?? /^(?:请在|在)\s*(.+?)\s*(?:里|中)?\s*(?:做|执行|处理|运行|跑|修复|检查|改)\s*(.+)$/u.exec(text)
  if (!match?.[1] || !match[2]) return null
  const targetDescription = match[1].trim()
  const task = match[2].trim()
  if (targetDescription === '' || task === '') return null
  return { targetDescription, task, mode: /立即|马上|立刻|打断|改方向|停止当前/u.test(text) ? 'steer' : 'queue' }
}

function isSummaryIntent(text: string): boolean {
  return /进展|状态|在跑|运行中|完成了什么|有什么任务|汇总|总结|待处理|等我处理/u.test(text) && !/让|叫|通知/u.test(text)
}

function resolveOrdinalTarget(description: string, entries: readonly SessionIndexEntry[]): readonly SessionIndexEntry[] | null {
  const match = /(?:工作区\s*)?(.+?)?\s*(?:第\s*([一二三四五六七八九十\d]+)\s*个|第\s*([一二三四五六七八九十\d]+)\s*个会话)/u.exec(description)
  if (!match) return null
  const workspace = match[1]?.trim()
  const ordinalText = match[2] ?? match[3]
  const ordinal = parseChineseNumber(ordinalText)
  if (ordinal === null || ordinal < 1) return []
  const scoped = workspace === undefined || workspace === '' ? entries : entries.filter((entry) => normalize(entry.workspaceName).includes(normalize(workspace)))
  return scoped.slice(ordinal - 1, ordinal)
}

function parseChineseNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  if (/^\d+$/u.test(value)) return Number(value)
  const values: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  return values[value] ?? null
}

function normalize(value: string): string {
  return value.toLocaleLowerCase('zh-CN').replace(/[\s，。！？、,.!?]/gu, '')
}
