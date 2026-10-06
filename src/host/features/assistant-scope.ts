/**
 * 编程助理的受管范围契约。
 *
 * 这个模块只处理值和集合，不读取 DSH 服务，也不保存状态。索引层、意图层和
 * 派发层都必须先经过这里，才能保证「受管工作区 ∩ 未归档会话」只有一种实现。
 */

const EMPTY_SCOPE_MESSAGE = '尚未选择任何工作区'

/** 用户显式勾选的工作区范围；归档会话永远不会被纳入。 */
export interface AssistantScope {
  readonly managedWorkspaceIds: readonly string[]
  readonly includeArchived: false
}

/** 参与范围计算的最小会话形状。 */
export interface AssistantScopeSession {
  readonly sessionId: string
  readonly workspaceId: string
}

/** 受管范围为空时必须向上层暴露的明确状态。 */
export type AssistantScopeState =
  | {
      readonly status: 'empty'
      readonly reason: 'no-managed-workspaces'
      readonly message: '尚未选择任何工作区'
    }
  | {
      readonly status: 'ready'
      readonly managedWorkspaceIds: readonly string[]
    }

/** 范围过滤的结果，同时保留空范围状态，避免把空范围误报成「没有进展」。 */
export interface AssistantScopeFilterResult<T> {
  readonly state: AssistantScopeState
  readonly sessions: readonly T[]
}

/** 派发或查询目标被范围边界拒绝时的结构化原因。 */
export type AssistantScopeRejection =
  | {
      readonly code: 'scope-empty'
      readonly message: string
    }
  | {
      readonly code: 'workspace-outside-scope'
      readonly workspaceId: string
      readonly message: string
    }
  | {
      readonly code: 'session-archived'
      readonly sessionId: string
      readonly message: string
    }

/** 可以用于目标校验的最小目标形状。 */
export interface AssistantScopeTarget {
  readonly workspaceId: string
  readonly sessionId?: string
}

/**
 * 创建规范化的受管范围。
 *
 * 工作区 ID 会去除首尾空白、删除空值并去重，顺序按用户输入保留。每次调用
 * 都返回新数组，不会修改调用方传入的数组。
 */
export function createAssistantScope(managedWorkspaceIds: readonly string[]): AssistantScope {
  return {
    managedWorkspaceIds: normalizeWorkspaceIds(managedWorkspaceIds),
    includeArchived: false,
  }
}

/** 判断用户是否还没有显式勾选任何工作区。 */
export function isAssistantScopeEmpty(scope: AssistantScope): boolean {
  return normalizeWorkspaceIds(scope.managedWorkspaceIds).length === 0
}

/** 返回可直接供 UI 或语音层使用的范围状态。 */
export function getAssistantScopeState(scope: AssistantScope): AssistantScopeState {
  const managedWorkspaceIds = normalizeWorkspaceIds(scope.managedWorkspaceIds)
  if (managedWorkspaceIds.length === 0) {
    return {
      status: 'empty',
      reason: 'no-managed-workspaces',
      message: EMPTY_SCOPE_MESSAGE,
    }
  }
  return { status: 'ready', managedWorkspaceIds }
}

/**
 * 返回受管范围内且未归档的会话。
 *
 * 归档集合接受 Set 或数组，便于直接接入 workspaceRegistry 的快照；函数只读
 * 输入集合，不会为了过滤而修改任何对象。空范围返回空数组，但调用方若需要
 * 展示原因，应同时读取 getAssistantScopeState 或使用 filterAssistantSessions。
 */
export function filterSessionsByAssistantScope<T extends AssistantScopeSession>(
  sessions: readonly T[],
  scope: AssistantScope,
  archivedSessionIds: ReadonlySet<string> | readonly string[],
): readonly T[] {
  const managedWorkspaceIds = normalizeWorkspaceIds(scope.managedWorkspaceIds)
  if (managedWorkspaceIds.length === 0) return []

  const managed = new Set(managedWorkspaceIds)
  const archived = toReadonlySet(archivedSessionIds)
  return sessions.filter((session) => managed.has(session.workspaceId) && !archived.has(session.sessionId))
}

/** 过滤并返回范围状态，避免空范围被误解为「没有符合条件的会话」。 */
export function filterAssistantSessions<T extends AssistantScopeSession>(
  sessions: readonly T[],
  scope: AssistantScope,
  archivedSessionIds: ReadonlySet<string> | readonly string[],
): AssistantScopeFilterResult<T> {
  return {
    state: getAssistantScopeState(scope),
    sessions: filterSessionsByAssistantScope(sessions, scope, archivedSessionIds),
  }
}

/**
 * 校验目标是否仍在助理可访问范围内。
 *
 * 返回 null 表示允许；返回结构化原因表示必须拒绝，调用方不得继续读取或派发。
 * 归档判断放在工作区判断之后，保证空范围和范围外目标不会泄露归档状态。
 */
export function getAssistantScopeRejection(
  scope: AssistantScope,
  target: AssistantScopeTarget,
  archivedSessionIds: ReadonlySet<string> | readonly string[],
): AssistantScopeRejection | null {
  const managedWorkspaceIds = normalizeWorkspaceIds(scope.managedWorkspaceIds)
  if (managedWorkspaceIds.length === 0) {
    return {
      code: 'scope-empty',
      message: '尚未选择任何工作区，无法访问会话；请打开全局智能助理设置并勾选工作区后重试',
    }
  }

  if (!managedWorkspaceIds.includes(target.workspaceId)) {
    return {
      code: 'workspace-outside-scope',
      workspaceId: target.workspaceId,
      message: `工作区「${target.workspaceId}」不在助理受管范围内；请打开全局智能助理设置并勾选该工作区后重试`,
    }
  }

  if (target.sessionId !== undefined && toReadonlySet(archivedSessionIds).has(target.sessionId)) {
    return {
      code: 'session-archived',
      sessionId: target.sessionId,
      message: `会话「${target.sessionId}」已归档，不在助理索引范围内`,
    }
  }

  return null
}

/** 返回目标是否可以被助理读取或派发。 */
export function isAssistantScopeTargetAllowed(
  scope: AssistantScope,
  target: AssistantScopeTarget,
  archivedSessionIds: ReadonlySet<string> | readonly string[],
): boolean {
  return getAssistantScopeRejection(scope, target, archivedSessionIds) === null
}

function toReadonlySet(values: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values)
}

function normalizeWorkspaceIds(workspaceIds: readonly string[]): readonly string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const rawId of workspaceIds) {
    const id = rawId.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
}
