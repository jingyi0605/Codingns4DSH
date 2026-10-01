import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  CodingNsTerminalCreateRequest,
  CodingNsTerminalEnvironment,
  CodingNsTerminalFrame,
  CodingNsTerminalShellOption,
  CodingNsWebTerminalInfo,
  TerminalAttachmentId,
  WebTerminalId,
} from '../../shared/contracts/terminal.js'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { debugInfo, debugWarn } from '../../shared/debug.js'
import { resolveCodingNsTranslator, type CodingNsTranslator } from '../locale.js'

export type { TerminalAttachmentId, WebTerminalId } from '../../shared/contracts/terminal.js'
export type TerminalEnvironment = CodingNsTerminalEnvironment
export type TerminalFrame = CodingNsTerminalFrame
export type TerminalShell = CodingNsTerminalShellOption
export type WebTerminalInfo = CodingNsWebTerminalInfo

/** 只描述自有 Client 实际调用的公开 terminal wire 接口。 */
export interface TerminalRemote {
  close(sessionId: string, id: WebTerminalId): Promise<RemoteResult<void>>
  create(sessionId: string, request: CodingNsTerminalCreateRequest, signal?: AbortSignal): Promise<RemoteResult<WebTerminalInfo>>
  environment(sessionId: string, signal?: AbortSignal): Promise<RemoteResult<TerminalEnvironment>>
  follow(sessionId: string, id: WebTerminalId, attachmentId: TerminalAttachmentId, signal?: AbortSignal): AsyncIterable<TerminalFrame>
  list(sessionId: string): Promise<RemoteResult<WebTerminalInfo[]>>
  rename(sessionId: string, id: WebTerminalId, title: string): Promise<RemoteResult<void>>
  resize(sessionId: string, id: WebTerminalId, attachmentId: TerminalAttachmentId, cols: number, rows: number): Promise<RemoteResult<void>>
  shells(sessionId: string, signal?: AbortSignal): Promise<RemoteResult<TerminalShell[]>>
  write(sessionId: string, id: WebTerminalId, attachmentId: TerminalAttachmentId, data: string): Promise<RemoteResult<void>>
}

export type TerminalRemoteSource = TerminalRemote | (() => TerminalRemote | undefined)

export interface TerminalRenderFrame {
  readonly revision: number
  readonly frame: Extract<TerminalFrame, { readonly type: 'snapshot' | 'output' }>
}

export interface TerminalViewState {
  readonly phase: 'idle' | 'loading' | 'creating' | 'connecting' | 'connected' | 'disconnected' | 'closing' | 'closed' | 'failed'
  readonly environment?: TerminalEnvironment
  readonly info?: WebTerminalInfo
  readonly title: string
  readonly writable: boolean
  readonly render?: TerminalRenderFrame
  readonly error?: string
}

export interface TerminalLaunchShells {
  readonly shells: readonly TerminalShell[]
  readonly selectedShell?: string
}

export interface TerminalCloseFailure {
  readonly sessionId: string
  readonly id: WebTerminalId
  readonly title: string
  readonly message: string
}

export interface TerminalObservable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

class ObservableValue<T> implements TerminalObservable<T> {
  private readonly listeners = new Set<() => void>()
  constructor(private value: T) {}
  getSnapshot(): T { return this.value }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  set(value: T): void {
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }
}

interface PendingRender {
  readonly revision: number
  readonly resolve: () => void
}

interface WorkspaceBindingResolution {
  readonly id: WebTerminalId
  /** 是否来自已有工作区绑定；新建绑定仍允许本次 view 创建 Host 终端。 */
  readonly existing: boolean
}

/** 一个 Sidebar 标签对应的终端模型；DOM 卸载只 detach，显式 close 才结束 Host 进程。 */
export class CodingNsTerminalView {
  readonly state: TerminalObservable<TerminalViewState>
  id: WebTerminalId
  private readonly store: ObservableValue<TerminalViewState>
  private readonly lifetime = new AbortController()
  private followController: AbortController | undefined
  private pendingRender: PendingRender | undefined
  private mounted = 0
  private revision = 0
  private loading: Promise<void> | undefined
  private writes = Promise.resolve()
  private attachmentId: TerminalAttachmentId | undefined
  /** 最近一次已排队的尺寸；ResizeObserver 可能在同一布局周期内重复触发。 */
  private lastResize: { readonly attachmentId: TerminalAttachmentId; readonly cols: number; readonly rows: number } | undefined

  constructor(
    readonly sessionId: string,
    id: WebTerminalId,
    private readonly remote: TerminalRemoteSource,
    private readonly createWhenMissing: boolean,
    private readonly shellPath?: string,
    private readonly onWorkspaceResolved?: (workspaceId: string, id: WebTerminalId) => WorkspaceBindingResolution | undefined,
    // 追加在末尾：既有调用方与测试按位置传 shellPath / onWorkspaceResolved，不能前移。
    private readonly t: CodingNsTranslator = resolveCodingNsTranslator(),
  ) {
    this.id = id
    // 标签兜底标题必须走词典：字段初始化阶段还取不到构造参数，因此在构造函数里建 store。
    this.store = new ObservableValue<TerminalViewState>({ phase: 'idle', title: t('terminal.title'), writable: false })
    this.state = this.store
  }

  mount(): () => void {
    this.mounted += 1
    if (this.mounted === 1) void this.refresh()
    let active = true
    return () => {
      if (!active) return
      active = false
      this.mounted = Math.max(0, this.mounted - 1)
      if (this.mounted === 0) this.detach()
    }
  }

  async refresh(): Promise<void> {
    if (this.loading !== undefined) return this.loading
    if (this.lifetime.signal.aborted) return
    this.loading = this.load().finally(() => { this.loading = undefined })
    return this.loading
  }

  acknowledge(revision: number): void {
    if (this.pendingRender?.revision !== revision) return
    this.pendingRender.resolve()
    this.pendingRender = undefined
  }

  write(data: string): void {
    const state = this.store.getSnapshot()
    const attachmentId = this.attachmentId
    if (!state.writable || attachmentId === undefined || data === '') return
    const max = state.environment?.maxInputBytes ?? 64 * 1024
    if (new TextEncoder().encode(data).byteLength > max) {
      this.patch({ error: '终端输入超过允许上限' })
      return
    }
    this.writes = this.writes
      .then(async () => { unwrap(await resolveRemote(this.remote).write(this.sessionId, this.id, attachmentId, data)) })
      .catch((error: unknown) => this.fail(error))
  }

  resize(cols: number, rows: number): void {
    const state = this.store.getSnapshot()
    const attachmentId = this.attachmentId
    if (!state.writable || attachmentId === undefined) return
    const nextCols = Math.max(1, Math.min(Math.floor(cols), state.environment?.maxCols ?? 500))
    const nextRows = Math.max(1, Math.min(Math.floor(rows), state.environment?.maxRows ?? 200))
    const request = { attachmentId, cols: nextCols, rows: nextRows }
    if (sameResize(this.lastResize, request)) return
    this.lastResize = request
    this.writes = this.writes
      .then(async () => { unwrap(await resolveRemote(this.remote).resize(this.sessionId, this.id, attachmentId, nextCols, nextRows)) })
      .catch((error: unknown) => {
        if (sameResize(this.lastResize, request)) this.lastResize = undefined
        this.fail(error)
      })
  }

  async rename(title: string): Promise<void> {
    const normalized = title.trim()
    if (normalized === '' || normalized === this.store.getSnapshot().title) return
    try {
      unwrap(await resolveRemote(this.remote).rename(this.sessionId, this.id, normalized))
      const info = this.store.getSnapshot().info
      this.patch({ title: normalized, ...(info === undefined ? {} : { info: { ...info, title: normalized } }) })
    } catch (error) {
      this.fail(error)
    }
  }

  async close(): Promise<void> {
    if (this.store.getSnapshot().phase === 'closed') return
    debugInfo('codingns4dsh: client terminal close entered', { sessionId: this.sessionId, terminalId: this.id })
    this.patch({ phase: 'closing', writable: false })
    this.detach()
    unwrap(await resolveRemote(this.remote).close(this.sessionId, this.id))
    debugInfo('codingns4dsh: client terminal close success', { sessionId: this.sessionId, terminalId: this.id })
    this.patch({ phase: 'closed', writable: false })
  }

  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('终端 Client 已卸载'))
    this.detach()
    await this.writes.catch(() => undefined)
  }

  private async load(): Promise<void> {
    this.patch({ phase: 'loading', writable: false })
    try {
      const remote = resolveRemote(this.remote)
      const environment = unwrap(await remote.environment(this.sessionId, this.lifetime.signal))
      debugInfo('codingns4dsh: client terminal environment', { sessionId: this.sessionId, workspaceId: environment.workspaceId, cwd: environment.cwd })
      let createWhenMissing = this.createWhenMissing
      if (environment.workspaceId !== undefined) {
        const binding = this.onWorkspaceResolved?.(environment.workspaceId, this.id)
        debugInfo('codingns4dsh: client terminal workspace binding', { sessionId: this.sessionId, workspaceId: environment.workspaceId, requestedId: this.id, binding: binding ?? null })
        if (binding !== undefined) {
          if (binding.id !== this.id) this.id = binding.id
          // 工作区已有绑定时，恢复必须失败闭合，不能用新 ID 偷建替代终端。
          createWhenMissing = !binding.existing
        }
      }
      const listed = unwrap(await remote.list(this.sessionId))
      debugInfo('codingns4dsh: client terminal list', { sessionId: this.sessionId, workspaceId: environment.workspaceId, terminalIds: listed.map((entry) => entry.id), requestedId: this.id, createWhenMissing })
      let info = listed.find((entry) => entry.id === this.id)
      if (info === undefined && createWhenMissing) {
        this.patch({ phase: 'creating', environment })
        info = unwrap(await remote.create(this.sessionId, {
          id: this.id,
          ...(this.shellPath === undefined ? {} : { shellPath: this.shellPath }),
          cols: Math.min(80, environment.maxCols),
          rows: Math.min(24, environment.maxRows),
        }, this.lifetime.signal))
        debugInfo('codingns4dsh: client terminal created', { sessionId: this.sessionId, workspaceId: environment.workspaceId, terminalId: info.id })
      }
      if (info === undefined) throw new Error('Host 中不存在该终端，且恢复流程禁止自动创建替代进程')
      this.patch({ environment, info, title: info.title })
      if (this.mounted > 0) this.connect()
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.fail(error)
    }
  }

  private connect(): void {
    if (this.followController !== undefined || this.lifetime.signal.aborted || this.mounted === 0) return
    const controller = new AbortController()
    this.followController = controller
    this.attachmentId = crypto.randomUUID() as TerminalAttachmentId
    this.lastResize = undefined
    this.patch({ phase: 'connecting', writable: false })
    void this.consume(controller.signal)
  }

  private async consume(signal: AbortSignal): Promise<void> {
    try {
      const attachmentId = this.attachmentId
      if (attachmentId === undefined) return
      for await (const frame of resolveRemote(this.remote).follow(this.sessionId, this.id, attachmentId, signal)) {
        if (signal.aborted) break
        if (frame.type === 'state') {
          this.patch({ info: frame.info, title: frame.info.title })
          continue
        }
        await this.deliver(frame)
      }
      if (!signal.aborted) this.patch({ phase: 'disconnected', writable: false })
    } catch (error) {
      if (!signal.aborted) this.fail(error)
    } finally {
      if (this.followController?.signal === signal) {
        this.followController = undefined
        this.attachmentId = undefined
      }
    }
  }

  private async deliver(frame: Extract<TerminalFrame, { readonly type: 'snapshot' | 'output' }>): Promise<void> {
    this.pendingRender?.resolve()
    this.revision += 1
    let resolveWaiting = (): void => {}
    const waiting = new Promise<void>((resolve) => { resolveWaiting = resolve })
    this.pendingRender = { revision: this.revision, resolve: resolveWaiting }
    this.patch({ phase: 'connected', writable: true, render: { revision: this.revision, frame } })
    await waiting
  }

  private detach(): void {
    this.pendingRender?.resolve()
    this.pendingRender = undefined
    this.followController?.abort(new Error('终端视图已 detach'))
    this.followController = undefined
    this.attachmentId = undefined
    this.lastResize = undefined
    if (!this.lifetime.signal.aborted && this.store.getSnapshot().phase !== 'closed') {
      const { render: _render, ...state } = this.store.getSnapshot()
      this.store.set({ ...state, phase: 'disconnected', writable: false })
    }
  }

  private patch(patch: Partial<TerminalViewState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  private fail(error: unknown): void {
    this.patch({ phase: 'failed', writable: false, error: errorMessage(error) })
  }
}

interface ViewRecord {
  readonly contentId: string
  readonly view: CodingNsTerminalView
}

interface CloseRequest {
  readonly sessionId: string
  readonly id: WebTerminalId
  readonly title: string
}

const BINDING_PREFIX = 'dsh.codingns.terminal.binding.v1.'
const CLOSE_REQUEST_KEY = 'dsh.codingns.terminal.close.v1'
const SHELL_KEY = 'dsh.codingns.terminal.shell.v1'

/** Codingns4DSH 自有的浏览器终端服务，不依赖官方 terminal-controller Client 实现。 */
export class CodingNsWebTerminals extends Service {
  private readonly views = new Map<string, ViewRecord>()
  private readonly workspaceIds = new Map<string, string>()
  private readonly recoveries = new Map<string, Promise<readonly WebTerminalInfo[]>>()
  private readonly closeFailureStore = new ObservableValue<readonly TerminalCloseFailure[]>([])
  readonly closeFailures: TerminalObservable<readonly TerminalCloseFailure[]> = this.closeFailureStore
  private readonly remoteReadyStore = new ObservableValue(false)
  readonly remoteReadyState: TerminalObservable<boolean> = this.remoteReadyStore
  private readonly closeRequests = new Map<string, CloseRequest>()
  /** Remote 注入前不能执行关闭请求；就绪后统一冲刷，避免把启动竞态显示成永久错误。 */
  private cleanupQueued = false

  constructor(ctx: Context, private readonly remote: TerminalRemoteSource, private readonly t: CodingNsTranslator = resolveCodingNsTranslator()) {
    super(ctx, 'webTerminals')
    for (const request of readCloseRequests()) this.closeRequests.set(String(request.id), request)
    void this.flushCleanup()
  }

  view(sessionId: string, key: string, contentId: string, terminalId?: WebTerminalId, shellPath?: string): CodingNsTerminalView {
    const mapKey = JSON.stringify([sessionId, key])
    const existing = this.views.get(mapKey)
    if (existing !== undefined) return existing.view
    const workspaceId = this.workspaceIds.get(sessionId)
    const saved = terminalId
      ?? (workspaceId === undefined ? undefined : readWorkspaceBindingWithMigration(workspaceId, contentId))
      ?? readBinding(sessionId, contentId)
    const id = saved ?? crypto.randomUUID() as WebTerminalId
    debugInfo('codingns4dsh: client terminal view', { sessionId, key, contentId, workspaceId: workspaceId ?? null, savedId: saved ?? null, terminalId: id, bindingSource: terminalId !== undefined ? 'argument' : workspaceId !== undefined && readWorkspaceBindingWithMigration(workspaceId, contentId) !== undefined ? 'workspace-storage' : readBinding(sessionId, contentId) !== undefined ? 'session-storage' : 'new' })
    if (saved === undefined) writeBinding(sessionId, contentId, id)
    const view = new CodingNsTerminalView(
      sessionId,
      id,
      this.remote,
      saved === undefined,
      shellPath,
      (resolvedWorkspaceId, currentId) => this.rememberWorkspace(sessionId, contentId, currentId, resolvedWorkspaceId),
      this.t,
    )
    this.views.set(mapKey, { contentId, view })
    return view
  }

  /** 返回某个 Sidebar 内容已经保存的 Host 终端身份，用于恢复时去重。 */
  boundTerminalId(sessionId: string, contentId: string): WebTerminalId | undefined {
    const workspaceId = this.workspaceIds.get(sessionId)
    return (workspaceId === undefined ? undefined : readWorkspaceBindingWithMigration(workspaceId, contentId))
      ?? readBinding(sessionId, contentId)
  }

  async launchShells(sessionId: string, signal: AbortSignal): Promise<TerminalLaunchShells> {
    const shells = unwrap(await resolveRemote(this.remote).shells(sessionId, signal))
    const preferred = readString(SHELL_KEY)
    return {
      shells,
      ...(preferred !== null && shells.some((shell) => shell.path === preferred) ? { selectedShell: preferred } : {}),
    }
  }

  selectShell(path: string): void { writeString(SHELL_KEY, path) }

  close(sessionId: string, key: string, contentId: string, terminalId?: WebTerminalId): void {
    const mapKey = JSON.stringify([sessionId, key])
    const record = this.views.get(mapKey)
    const id = terminalId ?? record?.view.id ?? this.boundTerminalId(sessionId, contentId)
    if (id === undefined) return
    debugInfo('codingns4dsh: client terminal close request', { sessionId, key, contentId, workspaceId: this.workspaceIds.get(sessionId) ?? null, terminalId: id, hasView: record !== undefined })
    const request: CloseRequest = { sessionId, id, title: record?.view.state.getSnapshot().title ?? this.t('terminal.title') }
    this.closeRequests.set(String(id), request)
    persistCloseRequests(this.closeRequests.values())
    deleteBinding(sessionId, contentId)
    const workspaceId = this.workspaceIds.get(sessionId)
    if (workspaceId !== undefined) {
      deleteWorkspaceBinding(workspaceId)
      deleteLegacyWorkspaceBinding(workspaceId, contentId)
    }
    this.views.delete(mapKey)
    void this.cleanup(request, record?.view)
  }

  async recover(sessionId: string): Promise<readonly WebTerminalInfo[]> {
    const pending = this.recoveries.get(sessionId)
    if (pending !== undefined) return pending
    // 官方 list wire 只有 sessionId；先用 agent-scoped environment 让 Host 解析工作区。
    const recovery = (async () => {
      const environment = unwrap(await resolveRemote(this.remote).environment(sessionId))
      if (environment.workspaceId !== undefined) this.workspaceIds.set(sessionId, environment.workspaceId)
      const result = unwrap(await resolveRemote(this.remote).list(sessionId))
      debugInfo('codingns4dsh: client terminal recover', { sessionId, workspaceId: environment.workspaceId, terminalIds: result.map((entry) => entry.id) })
      return result
    })().finally(() => this.recoveries.delete(sessionId))
    this.recoveries.set(sessionId, recovery)
    return recovery
  }

  retryClose(id: WebTerminalId): void {
    const request = this.closeRequests.get(String(id))
    if (request !== undefined) void this.cleanup(request)
  }

  /** 由 Client 的 Remote 注入回调调用，完成启动阶段延迟的关闭请求。 */
  remoteReady(): void {
    debugInfo('codingns4dsh: client terminal remote ready notification')
    this.remoteReadyStore.set(true)
    void this.flushCleanup()
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.views.values()].map((record) => record.view.dispose()))
    this.views.clear()
    this.workspaceIds.clear()
    this.recoveries.clear()
  }

  private rememberWorkspace(sessionId: string, contentId: string, id: WebTerminalId, workspaceId: string): WorkspaceBindingResolution {
    this.workspaceIds.set(sessionId, workspaceId)
    const existing = readWorkspaceBindingWithMigration(workspaceId, contentId)
    const resolvedId = existing ?? id
    // 修正首次渲染时已经写入的会话键，避免第二个会话继续携带临时 ID。
    writeBinding(sessionId, contentId, resolvedId)
    // 旧版本的工作区键带 contentId；统一重写成只含 Workspace ID 的新键。
    writeWorkspaceBinding(workspaceId, contentId, resolvedId)
    deleteLegacyWorkspaceBinding(workspaceId, contentId)
    return { id: resolvedId, existing: existing !== undefined }
  }

  private async cleanup(request: CloseRequest, view?: CodingNsTerminalView): Promise<void> {
    try {
      debugInfo('codingns4dsh: client terminal cleanup begin', { sessionId: request.sessionId, terminalId: request.id, hasView: view !== undefined })
      if (view === undefined) unwrap(await resolveRemote(this.remote).close(request.sessionId, request.id))
      else await view.close()
      debugInfo('codingns4dsh: client terminal cleanup success', { sessionId: request.sessionId, terminalId: request.id })
      this.closeRequests.delete(String(request.id))
      persistCloseRequests(this.closeRequests.values())
      this.closeFailureStore.set(this.closeFailureStore.getSnapshot().filter((item) => item.id !== request.id))
    } catch (error) {
      if (isTerminalRemoteUnavailable(error)) {
        debugInfo('codingns4dsh: client terminal cleanup deferred', { sessionId: request.sessionId, terminalId: request.id })
        return
      }
      debugWarn('codingns4dsh: client terminal cleanup failed', { sessionId: request.sessionId, terminalId: request.id, error: errorMessage(error) })
      const failure: TerminalCloseFailure = { ...request, message: errorMessage(error) }
      this.closeFailureStore.set([...this.closeFailureStore.getSnapshot().filter((item) => item.id !== request.id), failure])
    }
  }

  private async flushCleanup(): Promise<void> {
    if (this.cleanupQueued || this.closeRequests.size === 0) return
    try {
      resolveRemote(this.remote)
    } catch (error) {
      if (isTerminalRemoteUnavailable(error)) {
        debugInfo('codingns4dsh: client terminal cleanup waiting for remote')
        return
      }
      throw error
    }
    this.cleanupQueued = true
    try {
      for (const request of [...this.closeRequests.values()]) await this.cleanup(request)
    } finally {
      this.cleanupQueued = false
    }
  }
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (typeof result !== 'object' || result === null || !('ok' in result)) {
    throw new Error('终端服务返回了无效响应')
  }
  if (result.ok) return result.value
  throw result.error
}

/**
 * 终端 Remote 尚未注入时的稳定错误。
 *
 * 调用方按类型判断可用性，不能比较本地化后的 message 文本。
 */
export class TerminalRemoteUnavailableError extends Error {
  constructor() {
    super('终端服务尚未就绪，请稍后重试')
    this.name = 'TerminalRemoteUnavailableError'
  }
}

function resolveRemote(source: TerminalRemoteSource): TerminalRemote {
  const remote = typeof source === 'function' ? source() : source
  if (remote === undefined) throw new TerminalRemoteUnavailableError()
  return remote
}

function sameResize(
  left: { readonly attachmentId: TerminalAttachmentId; readonly cols: number; readonly rows: number } | undefined,
  right: { readonly attachmentId: TerminalAttachmentId; readonly cols: number; readonly rows: number },
): boolean {
  return left?.attachmentId === right.attachmentId && left.cols === right.cols && left.rows === right.rows
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTerminalRemoteUnavailable(error: unknown): boolean {
  return error instanceof TerminalRemoteUnavailableError
}

function bindingKey(sessionId: string, contentId: string): string {
  return `${BINDING_PREFIX}${JSON.stringify([sessionId, contentId])}`
}

function workspaceBindingKey(workspaceId: string): string {
  // 工作区模式的终端身份不能带 session、tab 或 contentId；这些值在每个
  // DSH 会话中都会重新生成，带进去就会把所谓的工作区绑定重新拆回会话绑定。
  return `${BINDING_PREFIX}${JSON.stringify(['workspace', workspaceId])}`
}

/** 0.1.7 早期构建把 contentId 写进了工作区键，读取它只用于一次迁移。 */
function legacyWorkspaceBindingKey(workspaceId: string, contentId: string): string {
  return `${BINDING_PREFIX}${JSON.stringify(['workspace', workspaceId, contentId])}`
}

function readBinding(sessionId: string, contentId: string): WebTerminalId | undefined {
  const value = readString(bindingKey(sessionId, contentId))
  return value !== null && /^[\w-]{1,128}$/u.test(value) ? value as WebTerminalId : undefined
}

function writeBinding(sessionId: string, contentId: string, id: WebTerminalId): void {
  writeString(bindingKey(sessionId, contentId), String(id))
}

function readWorkspaceBinding(workspaceId: string, _contentId?: string): WebTerminalId | undefined {
  const value = readString(workspaceBindingKey(workspaceId))
  return value !== null && /^[\w-]{1,128}$/u.test(value) ? value as WebTerminalId : undefined
}

function readWorkspaceBindingWithMigration(workspaceId: string, contentId: string): WebTerminalId | undefined {
  const current = readWorkspaceBinding(workspaceId)
  if (current !== undefined) return current
  const legacy = readString(legacyWorkspaceBindingKey(workspaceId, contentId))
  return legacy !== null && /^[\w-]{1,128}$/u.test(legacy) ? legacy as WebTerminalId : undefined
}

function writeWorkspaceBinding(workspaceId: string, _contentId: string, id: WebTerminalId): void {
  writeString(workspaceBindingKey(workspaceId), String(id))
}

function deleteWorkspaceBinding(workspaceId: string, _contentId?: string): void {
  try { localStorage.removeItem(workspaceBindingKey(workspaceId)) } catch { /* 浏览器禁用存储时仅失去跨刷新绑定。 */ }
}

function deleteLegacyWorkspaceBinding(workspaceId: string, contentId: string): void {
  try { localStorage.removeItem(legacyWorkspaceBindingKey(workspaceId, contentId)) } catch { /* 浏览器禁用存储时仅失去跨刷新绑定。 */ }
}

function deleteBinding(sessionId: string, contentId: string): void {
  try { localStorage.removeItem(bindingKey(sessionId, contentId)) } catch { /* 浏览器禁用存储时仅失去跨刷新绑定。 */ }
}

function readCloseRequests(): readonly CloseRequest[] {
  const raw = readString(CLOSE_REQUEST_KEY)
  if (raw === null) return []
  try {
    const values: unknown = JSON.parse(raw)
    if (!Array.isArray(values)) return []
    return values.filter(isCloseRequest)
  } catch {
    return []
  }
}

function isCloseRequest(value: unknown): value is CloseRequest {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.sessionId === 'string' && typeof record.id === 'string' && typeof record.title === 'string'
}

function persistCloseRequests(requests: Iterable<CloseRequest>): void {
  writeString(CLOSE_REQUEST_KEY, JSON.stringify([...requests]))
}

function readString(key: string): string | null {
  if (typeof localStorage === 'undefined') return null
  try { return localStorage.getItem(key) } catch { return null }
}

function writeString(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(key, value) } catch { /* 无痕或受限环境继续使用内存状态。 */ }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Codingns4DSH 自有的浏览器终端模型服务。 */
    webTerminals: CodingNsWebTerminals
  }
}
