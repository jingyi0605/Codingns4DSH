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

/** 一个 Sidebar 标签对应的终端模型；DOM 卸载只 detach，显式 close 才结束 Host 进程。 */
export class CodingNsTerminalView {
  readonly state: TerminalObservable<TerminalViewState>
  private readonly store = new ObservableValue<TerminalViewState>({ phase: 'idle', title: '终端', writable: false })
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
    readonly id: WebTerminalId,
    private readonly remote: TerminalRemoteSource,
    private readonly createWhenMissing: boolean,
    private readonly shellPath?: string,
    private readonly onWorkspaceResolved?: (workspaceId: string) => void,
  ) {
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
    this.patch({ phase: 'closing', writable: false })
    this.detach()
    unwrap(await resolveRemote(this.remote).close(this.sessionId, this.id))
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
      if (environment.workspaceId !== undefined) this.onWorkspaceResolved?.(environment.workspaceId)
      const listed = unwrap(await remote.list(this.sessionId))
      let info = listed.find((entry) => entry.id === this.id)
      if (info === undefined && this.createWhenMissing) {
        this.patch({ phase: 'creating', environment })
        info = unwrap(await remote.create(this.sessionId, {
          id: this.id,
          ...(this.shellPath === undefined ? {} : { shellPath: this.shellPath }),
          cols: Math.min(80, environment.maxCols),
          rows: Math.min(24, environment.maxRows),
        }, this.lifetime.signal))
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

/** CodingNS 自有的浏览器终端服务，不依赖官方 terminal-controller Client 实现。 */
export class CodingNsWebTerminals extends Service {
  private readonly views = new Map<string, ViewRecord>()
  private readonly workspaceIds = new Map<string, string>()
  private readonly recoveries = new Map<string, Promise<readonly WebTerminalInfo[]>>()
  private readonly closeFailureStore = new ObservableValue<readonly TerminalCloseFailure[]>([])
  readonly closeFailures: TerminalObservable<readonly TerminalCloseFailure[]> = this.closeFailureStore
  private readonly closeRequests = new Map<string, CloseRequest>()

  constructor(ctx: Context, private readonly remote: TerminalRemoteSource) {
    super(ctx, 'webTerminals')
    for (const request of readCloseRequests()) this.closeRequests.set(String(request.id), request)
    for (const request of this.closeRequests.values()) void this.cleanup(request)
  }

  view(sessionId: string, key: string, contentId: string, terminalId?: WebTerminalId, shellPath?: string): CodingNsTerminalView {
    const mapKey = JSON.stringify([sessionId, key])
    const existing = this.views.get(mapKey)
    if (existing !== undefined) return existing.view
    const workspaceId = this.workspaceIds.get(sessionId)
    const saved = terminalId
      ?? (workspaceId === undefined ? undefined : readWorkspaceBinding(workspaceId, contentId))
      ?? readBinding(sessionId, contentId)
    const id = saved ?? crypto.randomUUID() as WebTerminalId
    if (saved === undefined) writeBinding(sessionId, contentId, id)
    const view = new CodingNsTerminalView(
      sessionId,
      id,
      this.remote,
      saved === undefined,
      shellPath,
      (resolvedWorkspaceId) => this.rememberWorkspace(sessionId, contentId, id, resolvedWorkspaceId),
    )
    this.views.set(mapKey, { contentId, view })
    return view
  }

  /** 返回某个 Sidebar 内容已经保存的 Host 终端身份，用于恢复时去重。 */
  boundTerminalId(sessionId: string, contentId: string): WebTerminalId | undefined {
    const workspaceId = this.workspaceIds.get(sessionId)
    return (workspaceId === undefined ? undefined : readWorkspaceBinding(workspaceId, contentId))
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
    const request: CloseRequest = { sessionId, id, title: record?.view.state.getSnapshot().title ?? '终端' }
    this.closeRequests.set(String(id), request)
    persistCloseRequests(this.closeRequests.values())
    deleteBinding(sessionId, contentId)
    const workspaceId = this.workspaceIds.get(sessionId)
    if (workspaceId !== undefined) deleteWorkspaceBinding(workspaceId, contentId)
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
      return unwrap(await resolveRemote(this.remote).list(sessionId))
    })().finally(() => this.recoveries.delete(sessionId))
    this.recoveries.set(sessionId, recovery)
    return recovery
  }

  retryClose(id: WebTerminalId): void {
    const request = this.closeRequests.get(String(id))
    if (request !== undefined) void this.cleanup(request)
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.views.values()].map((record) => record.view.dispose()))
    this.views.clear()
    this.workspaceIds.clear()
    this.recoveries.clear()
  }

  private rememberWorkspace(sessionId: string, contentId: string, id: WebTerminalId, workspaceId: string): void {
    this.workspaceIds.set(sessionId, workspaceId)
    writeWorkspaceBinding(workspaceId, contentId, id)
  }

  private async cleanup(request: CloseRequest, view?: CodingNsTerminalView): Promise<void> {
    try {
      if (view === undefined) unwrap(await resolveRemote(this.remote).close(request.sessionId, request.id))
      else await view.close()
      this.closeRequests.delete(String(request.id))
      persistCloseRequests(this.closeRequests.values())
      this.closeFailureStore.set(this.closeFailureStore.getSnapshot().filter((item) => item.id !== request.id))
    } catch (error) {
      const failure: TerminalCloseFailure = { ...request, message: errorMessage(error) }
      this.closeFailureStore.set([...this.closeFailureStore.getSnapshot().filter((item) => item.id !== request.id), failure])
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

function resolveRemote(source: TerminalRemoteSource): TerminalRemote {
  const remote = typeof source === 'function' ? source() : source
  if (remote === undefined) throw new Error('终端服务尚未就绪，请稍后重试')
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

function bindingKey(sessionId: string, contentId: string): string {
  return `${BINDING_PREFIX}${JSON.stringify([sessionId, contentId])}`
}

function workspaceBindingKey(workspaceId: string, contentId: string): string {
  return `${BINDING_PREFIX}${JSON.stringify(['workspace', workspaceId, contentId])}`
}

function readBinding(sessionId: string, contentId: string): WebTerminalId | undefined {
  const value = readString(bindingKey(sessionId, contentId))
  return value !== null && /^[\w-]{1,128}$/u.test(value) ? value as WebTerminalId : undefined
}

function writeBinding(sessionId: string, contentId: string, id: WebTerminalId): void {
  writeString(bindingKey(sessionId, contentId), String(id))
}

function readWorkspaceBinding(workspaceId: string, contentId: string): WebTerminalId | undefined {
  const value = readString(workspaceBindingKey(workspaceId, contentId))
  return value !== null && /^[\w-]{1,128}$/u.test(value) ? value as WebTerminalId : undefined
}

function writeWorkspaceBinding(workspaceId: string, contentId: string, id: WebTerminalId): void {
  writeString(workspaceBindingKey(workspaceId, contentId), String(id))
}

function deleteWorkspaceBinding(workspaceId: string, contentId: string): void {
  try { localStorage.removeItem(workspaceBindingKey(workspaceId, contentId)) } catch { /* 浏览器禁用存储时仅失去跨刷新绑定。 */ }
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
    /** CodingNS 自有的浏览器终端模型服务。 */
    webTerminals: CodingNsWebTerminals
  }
}
