import { parseVirtualSessionId, parseVirtualWorkspaceId } from '../../shared/contracts/peer-host.js'
import type { TerminalShareTarget } from '../../shared/contracts/terminal-share.js'

interface ServiceContext { get(name: string): unknown }
interface Store { getSnapshot(): unknown }
interface Span { readonly start: number; readonly end: number; readonly draftRev: number }
export interface TerminalDraftReference {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'file'
  readonly clipboardText: string
}
interface DraftInput {
  readonly state: { getSnapshot(): { readonly phase: string; readonly draftRev: number } }
  readonly actions?: {
    captureInsertion(): Span
    insertText(text: string, span: Span): boolean
    persistDraft?(): void
  }
  caretSpan?(): { readonly start: number; readonly end: number }
  insertText?(text: string, span: Span): boolean
  insertReference?(reference: TerminalDraftReference, span: Span): boolean
  persistCurrentDraft?(): void
  focus(): void
}
interface Sessions {
  readonly list?: Store
  scope(sessionId: string): unknown
  create?(options: { readonly workspaceId: string }): Promise<string>
}
interface Conversation { readonly input: { for(scope: unknown): DraftInput } }
interface Navigation { openSession(sessionId: string): unknown }

export interface TerminalReferenceCodec {
  clipboardText(ref: string): string
  serialize(ref: string, signal: AbortSignal): Promise<string>
}
interface ReferenceRegistry {
  registerSource(source: {
    readonly name: string
    readonly trigger: '@'
    candidates(): Promise<readonly never[]>
    onPick(): { readonly text: string }
    readonly codec: TerminalReferenceCodec
  }): () => void
}

export interface TerminalSharingBridge {
  targets(signal?: AbortSignal, query?: { readonly sessionId: string; readonly limit: number }): Promise<readonly TerminalShareTarget[]>
  source(sessionId: string): { readonly hostId: string; readonly workspaceId: string }
  registerReferences(name: string, codec: TerminalReferenceCodec): (() => void) | undefined
  createTarget(sourceSessionId: string): Promise<string>
  insert(sessionId: string, text: string, reference?: TerminalDraftReference): Promise<void>
}

/** DSH 版本差异只在本适配器探测，终端业务不读取宿主私有编辑器。 */
export function supportsTerminalSharing(context: unknown): boolean {
  return typeof service<Sessions>(context, 'sessions')?.scope === 'function'
    && typeof service<Conversation>(context, 'conversation')?.input?.for === 'function'
    && typeof service<Navigation>(context, 'uiWorkspace')?.openSession === 'function'
}

export function createTerminalSharingBridge(context: unknown): TerminalSharingBridge {
  if (!supportsTerminalSharing(context)) throw new Error('当前 DSH 缺少会话草稿分享能力')
  const sessions = service<Sessions>(context, 'sessions')!
  const conversation = service<Conversation>(context, 'conversation')!
  const navigation = service<Navigation>(context, 'uiWorkspace')!
  const workspaceSnapshot = (): unknown => service<{ readonly list?: Store }>(context, 'workspaces')?.list?.getSnapshot()
  return {
    async targets(signal, query) {
      const rows = new Map<string, unknown>()
      const state = record(sessions.list?.getSnapshot())
      const localRows = record(state?.byId) ?? {}
      for (const [id, value] of Object.entries(localRows)) rows.set(id, { ...record(value), sessionId: id })
      const remote = service<{ list(request: { readonly cursor?: string }, signal?: AbortSignal): Promise<unknown> }>(context, 'remote.session')
      let cursor: string | undefined
      const cursors = new Set<string>()
      const selectTargets = (): readonly TerminalShareTarget[] => {
        const snapshot = workspaceSnapshot()
        const targets = readTerminalShareTargets([...rows.values()], snapshot)
        return query === undefined ? targets : selectRecentTerminalShareTargets(targets, snapshot, query.sessionId, query.limit)
      }
      // 只有当前工作区的摘要完整时才能直接排序，避免把已加载的旧会话当成最新。
      signal?.throwIfAborted()
      const workspace = query === undefined ? undefined : array(record(workspaceSnapshot())?.items).map(record)
        .find((item) => array(item?.sessionIds).includes(query.sessionId))
      const ids = array(workspace?.sessionIds)
      if (query !== undefined && ids.length > 0 && ids.every((id) => typeof id === 'string' && rows.has(id))) return selectTargets()
      // 菜单按原生接口补读一次摘要，不逐页遍历，不读取会话正文。
      do {
        signal?.throwIfAborted()
        if (remote?.list === undefined) break
        const page = record(unwrap(await remote.list(cursor === undefined ? {} : { cursor }, signal)))
        for (const value of array(page?.items)) {
          const id = string(record(value)?.sessionId)
          if (id !== '') rows.set(id, { ...record(value), ...record(localRows[id]), sessionId: id })
        }
        if (query !== undefined) break
        cursor = string(page?.nextCursor) || undefined
        if (cursor !== undefined && cursors.has(cursor)) throw new Error('会话列表分页游标重复')
        if (cursor !== undefined) cursors.add(cursor)
      } while (cursor !== undefined)
      signal?.throwIfAborted()
      return selectTargets()
    },
    source(sessionId) {
      const workspaces = array(record(workspaceSnapshot())?.items).map(record)
      const workspace = workspaces.find((item) => array(item?.sessionIds).includes(sessionId))
      return { hostId: parseVirtualSessionId(sessionId)?.hostId ?? 'local', workspaceId: string(workspace?.workspaceId) }
    },
    registerReferences(name, codec) {
      const triggers = service<ReferenceRegistry>(context, 'inputTriggers')
      return triggers?.registerSource?.({ name, trigger: '@', candidates: async () => [], onPick: () => ({ text: '' }), codec })
    },
    async createTarget(sourceSessionId) {
      const workspace = array(record(workspaceSnapshot())?.items).map(record)
        .find((item) => array(item?.sessionIds).includes(sourceSessionId))
      const workspaceId = string(workspace?.workspaceId)
      if (workspaceId === '') throw new Error('当前会话的工作区尚未就绪，请稍后重试')
      if (typeof sessions.create !== 'function') throw new Error('当前 DSH 缺少新建会话能力')
      // 不传已有 sessionId，明确创建新身份；虚拟工作区交给既有 PeerHost 原生路由。
      const sessionId = await sessions.create({ workspaceId })
      if (typeof sessionId !== 'string' || sessionId === '' || sessionId === sourceSessionId) throw new Error('未能创建新会话，请重试')
      return sessionId
    },
    async insert(sessionId, text, reference) {
      const assertActive = (): void => {
        if (isArchivedSession(sessionId, workspaceSnapshot())) throw new Error('目标会话已经归档，请重新选择会话')
      }
      assertActive()
      // openSession 负责正常保留目标 Session；禁止借用当前会话 scope 写另一个会话。
      await navigation.openSession(sessionId)
      assertActive()
      const scope = sessions.scope(sessionId)
      if (scope === undefined) throw new Error('目标会话尚未就绪，请重试')
      const input = conversation.input.for(scope)
      if (reference !== undefined && input.insertReference === undefined) throw new Error('目标会话暂不支持日志引用卡片，请稍后重试')
      const persist = input.actions?.persistDraft?.bind(input.actions) ?? input.persistCurrentDraft?.bind(input)
      if (persist === undefined) throw new Error('当前 DSH 缺少安全的草稿保存接口，请升级 DSH')
      const state = input.state.getSnapshot()
      if (state.phase !== 'plain' && state.phase !== 'claimed') throw new Error('目标会话正在提交消息，请稍后重试')
      const captured = input.actions?.captureInsertion()
      const selection = captured ?? input.caretSpan?.()
      if (selection === undefined) throw new Error('当前 DSH 不支持安全插入草稿，请升级 DSH')
      // 分享只能插入，不能替换目标会话已经选中的文字。
      const span = { start: selection.end, end: selection.end,
        draftRev: captured?.draftRev ?? state.draftRev }
      const applied = reference !== undefined && input.insertReference !== undefined
        ? input.insertReference(reference, span)
        : input.actions?.insertText(`\n\n${text}\n`, span) ?? input.insertText?.(`\n\n${text}\n`, span)
      if (applied !== true) throw new Error('目标草稿已变化或暂时不可编辑，请重试')
      // 原生草稿写入器尚未挂载时，挂载流程会自动保存最新语义文档。
      persist()
      input.focus()
    },
  }
}

/** 原生工作区快照同时包含 PeerHost 投影和归档集合。 */
export function readTerminalShareTargets(rows: readonly unknown[], snapshot: unknown): readonly TerminalShareTarget[] {
  const state = record(snapshot)
  const workspaces = array(state?.items).map(record)
  const archived = new Set(array(state?.archivedSessionIds))
  for (const workspace of workspaces) for (const id of array(workspace?.archivedSessionIds)) archived.add(id)
  return rows.flatMap((raw): TerminalShareTarget[] => {
    const item = record(raw)
    const sessionId = string(item?.sessionId) || string(item?.id)
    // blank 是原生未发送会话的标记；不能凭标题或输入框草稿判断，旧摘要缺少该字段时仍保留。
    if (sessionId === '' || item?.blank === true || archived.has(sessionId) || Number(item?.archivedAt) > 0) return []
    const workspace = workspaces.find((entry) => array(entry?.sessionIds).includes(sessionId))
    const workspaceId = string(workspace?.workspaceId) || string(item?.workspaceId)
    const hostId = parseVirtualSessionId(sessionId)?.hostId ?? parseVirtualWorkspaceId(workspaceId)?.hostId ?? 'local'
    const title = string(record(record(item?.projections)?.values)?.title) || string(item?.title) || sessionId
    return [{ sessionId, title, workspaceId, hostId,
      workspaceTitle: string(workspace?.title) || string(workspace?.path) || workspaceId,
      adapterId: string(item?.adapterId),
      ...(timestamp(item?.updatedAt) > 0 ? { updatedAt: timestamp(item?.updatedAt) } : {}),
    }]
  })
}

/** 新建入口由菜单单独提供；已有会话只按更新时间排序，初始最多五项。 */
export function selectRecentTerminalShareTargets(targets: readonly TerminalShareTarget[], snapshot: unknown, sessionId: string, limit = 5): readonly TerminalShareTarget[] {
  const workspace = array(record(snapshot)?.items).map(record).find((item) => array(item?.sessionIds).includes(sessionId))
  const workspaceId = string(workspace?.workspaceId) || targets.find((item) => item.sessionId === sessionId)?.workspaceId
  const workspaceOrder = array(workspace?.sessionIds)
  const scoped = targets.filter((item) => workspaceId ? item.workspaceId === workspaceId : item.sessionId === sessionId)
  const recent = scoped.sort((left, right) =>
    (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    || workspaceOrder.indexOf(left.sessionId) - workspaceOrder.indexOf(right.sessionId))
  return recent.slice(0, Math.max(1, limit))
}

function timestamp(value: unknown): number {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : 0
  return Number.isFinite(time) ? time : 0
}

function isArchivedSession(sessionId: string, snapshot: unknown): boolean {
  const state = record(snapshot)
  return array(state?.archivedSessionIds).includes(sessionId)
    || array(state?.items).some((workspace) => array(record(workspace)?.archivedSessionIds).includes(sessionId))
}

function service<T>(context: unknown, name: string): T | undefined {
  try {
    if (typeof (context as ServiceContext | undefined)?.get === 'function') return (context as ServiceContext).get(name) as T | undefined
    return (context as Record<string, unknown> | undefined)?.[name] as T | undefined
  } catch { return undefined }
}
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function string(value: unknown): string { return typeof value === 'string' ? value : '' }
function array(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : [] }
function unwrap(value: unknown): unknown {
  const item = record(value)
  if (item?.ok === false) throw new Error(string(record(item.error)?.message) || '读取会话列表失败')
  return item?.ok === true ? item.value : value
}
