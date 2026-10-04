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
import { stripTerminalDeviceAttributeResponses } from '../../shared/terminal-input.js'

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

/** 工作区终端库存快照；同一工作区的所有会话共享这份列表。 */
export interface TerminalInventorySnapshot {
  readonly workspaceId: string
  readonly terminals: readonly WebTerminalInfo[]
  readonly revision: number
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

interface TerminalInitialState {
  readonly environment?: TerminalEnvironment
  readonly info?: WebTerminalInfo
}

/** 一个 Sidebar 标签对应的终端模型；普通视图卸载只 detach，聚合视图可常驻 follow。 */
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
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempts = 0
  /**
   * 聚合终端由工作区库存拥有生命周期。
   *
   * 聚合页在切换右栏页签时可能会卸载 DOM，但 Host 里的终端仍然运行；
   * 这类视图不能因为一次 DOM 卸载就释放 follow，否则再次点开标签必然
  * 重新经历 environment/list/follow。显式 close 和 dispose 仍会强制释放。
  */
  private readonly keepAlive: boolean
  private readonly initialState: TerminalInitialState | undefined
  private initialStateConsumed = false

  constructor(
    readonly sessionId: string,
    id: WebTerminalId,
    private readonly remote: TerminalRemoteSource,
    private readonly createWhenMissing: boolean,
    private readonly shellPath?: string,
    private readonly onWorkspaceResolved?: (workspaceId: string, id: WebTerminalId) => WorkspaceBindingResolution | undefined,
    // 追加在末尾：既有调用方与测试按位置传 shellPath / onWorkspaceResolved，不能前移。
    private readonly t: CodingNsTranslator = resolveCodingNsTranslator(),
    keepAlive = false,
    initialState?: TerminalInitialState,
  ) {
    this.id = id
    this.keepAlive = keepAlive
    this.initialState = initialState
    // 标签兜底标题必须走词典：字段初始化阶段还取不到构造参数，因此在构造函数里建 store。
    this.store = new ObservableValue<TerminalViewState>({
      phase: initialState?.info === undefined ? 'idle' : 'disconnected',
      ...(initialState?.environment === undefined ? {} : { environment: initialState.environment }),
      ...(initialState?.info === undefined ? {} : { info: initialState.info }),
      title: initialState?.info?.title ?? t('terminal.title'),
      writable: false,
    })
    this.state = this.store
  }

  mount(): () => void {
    this.mounted += 1
    if (this.mounted === 1) {
      const initial = this.initialState
      if (!this.initialStateConsumed && initial?.info !== undefined) {
        this.initialStateConsumed = true
        // 库存快照已经证明终端仍在运行时，直接订阅 Host 常驻连接，
        // 不再为切换会话重新读取 environment/list。环境快照尚未到达时也
        // 可以 follow：environment 只影响输入上限和外观默认值，不能阻塞恢复。
        if (initial.info.state === 'running') this.connect()
        else void this.refresh()
      } else {
        void this.refresh()
      }
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      this.mounted = Math.max(0, this.mounted - 1)
      if (this.mounted === 0 && !this.keepAlive) this.detach()
    }
  }

  async refresh(): Promise<void> {
    if (this.loading !== undefined) return this.loading
    if (this.lifetime.signal.aborted) return
    this.loading = this.load().finally(() => { this.loading = undefined })
    return this.loading
  }

  /**
   * 运行时丢失后按当前绑定重建终端。
   *
   * 这是"进程已经不存在"时的显式恢复动作：沿用同一个 terminalId 与工作区绑定，
   * 让 Sidebar 标签、标题和尺寸都保持不变，而不是让用户去点"新建终端"。
   */
  async rebuild(): Promise<void> {
    if (this.loading !== undefined) return this.loading
    this.clearReconnect()
    this.reconnectAttempts = 0
    this.patch({ phase: 'loading', writable: false })
    const task = this.loadWithRebuild().finally(() => { this.loading = undefined })
    this.loading = task
    return task
  }

  private async loadWithRebuild(): Promise<void> {
    try {
      const remote = resolveRemote(this.remote)
      const environment = unwrap(await remote.environment(this.sessionId, this.lifetime.signal))
      this.patch({ phase: 'creating', environment })
      const info = unwrap(await remote.create(this.sessionId, {
        id: this.id,
        ...(this.shellPath === undefined ? {} : { shellPath: this.shellPath }),
        cols: Math.min(80, environment.maxCols),
        rows: Math.min(24, environment.maxRows),
      }, this.lifetime.signal))
      debugInfo('codingns4dsh: client terminal rebuilt', { sessionId: this.sessionId, terminalId: info.id })
      const { error: _error, ...rest } = this.store.getSnapshot()
      this.store.set({ ...rest, environment, info, title: info.title })
      if (this.mounted > 0) this.connect()
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.fail(error)
    }
  }

  acknowledge(revision: number): void {
    if (this.pendingRender?.revision !== revision) return
    this.pendingRender.resolve()
    this.pendingRender = undefined
  }

  write(data: string): void {
    data = stripTerminalDeviceAttributeResponses(data)
    if (data === '') return
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
          // 显式传入 terminalId 或读取到会话绑定时同样不能新建：工作区绑定
          // 可能刚被另一个会话的关闭动作删除，此时旧标签仍在卸载途中，不能
          // 把已经关闭的 ID 当成新终端重新 create。
          createWhenMissing = createWhenMissing && !binding.existing
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
    this.clearReconnect()
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
      if (!signal.aborted) {
        // 流正常结束但终端仍在运行：这是连接层断开（Host 重连、服务器短暂不可达），
        // 必须自动重连；只有真正结束的终端才停在终态。
        if (this.isRunning()) this.scheduleReconnect()
        else this.patch({ phase: 'disconnected', writable: false })
      }
    } catch (error) {
      if (!signal.aborted) {
        if (this.isRunning()) this.scheduleReconnect()
        else this.fail(error)
      }
    } finally {
      if (this.followController?.signal === signal) {
        this.followController = undefined
        this.attachmentId = undefined
      }
    }
  }

  private async deliver(frame: Extract<TerminalFrame, { readonly type: 'snapshot' | 'output' }>): Promise<void> {
    // 真正收到画面才算连接成功，退避计数在这里归零。
    this.reconnectAttempts = 0
    this.clearReconnect()
    this.pendingRender?.resolve()
    this.revision += 1
    let resolveWaiting = (): void => {}
    const waiting = new Promise<void>((resolve) => { resolveWaiting = resolve })
    this.pendingRender = { revision: this.revision, resolve: resolveWaiting }
    this.patch({ phase: 'connected', writable: true, render: { revision: this.revision, frame } })
    await waiting
  }

  private detach(): void {
    this.clearReconnect()
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

  /** 终端是否仍被认为在运行；终态（exited/failed/closed）不参与自动重连。 */
  private isRunning(): boolean {
    const state = this.store.getSnapshot()
    if (state.phase === 'closed' || state.phase === 'failed') return false
    if (state.info === undefined) return true
    return state.info.state === 'running'
  }

  /**
   * 恢复阶段 Host 列表为空时，判断当前标签是否仍有本地生命周期保护。
   * 新建终端在 create 完成前不能被恢复流程关闭；已连接且 Host 报告 running
   * 的终端也不能因为一次空列表响应被误判为残留。
   */
  isRecoveryProtected(): boolean {
    const state = this.store.getSnapshot()
    if (state.phase === 'closed' || state.phase === 'failed') return false
    if (this.createWhenMissing && (state.phase === 'idle' || state.phase === 'loading' || state.phase === 'creating')) return true
    return state.info?.id === this.id && state.info.state === 'running'
  }

  /**
   * 连接层断开后的自动重连。
   *
   * 指数退避到 5 秒封顶：DSH 重启、中继抖动或 tmux 服务器短暂不可达时，用户
   * 不需要手动点"重新连接"，也不会看到刷屏式的重试。
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined || this.lifetime.signal.aborted || this.mounted === 0) return
    const delay = Math.min(500 * 2 ** this.reconnectAttempts, 5000)
    this.reconnectAttempts += 1
    this.patch({ phase: 'disconnected', writable: false })
    debugInfo('codingns4dsh: client terminal reconnect scheduled', { sessionId: this.sessionId, terminalId: this.id, delay, attempt: this.reconnectAttempts })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.lifetime.signal.aborted || this.mounted === 0) return
      void this.refresh()
    }, delay)
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
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
  private readonly inventoryRevisionStore = new ObservableValue(0)
  /** 任一工作区库存变化都会递增；聚合页用它触发跨会话刷新。 */
  readonly inventoryRevision: TerminalObservable<number> = this.inventoryRevisionStore
  private readonly inventories = new Map<string, TerminalInventorySnapshot>()
  /** 已解析过的会话环境；切换回已有会话时无需再次请求 Host environment。 */
  private readonly environments = new Map<string, TerminalEnvironment>()
  /** 每个会话最近一次库存请求的序号；旧请求返回时不得覆盖新建结果。 */
  private readonly inventoryRequestIds = new Map<string, number>()
  /** 任意工作区刷新都会递增；尚未解析工作区的旧请求也必须随之失效。 */
  private inventoryEpoch = 0
  private readonly closeRequests = new Map<string, CloseRequest>()
  /** Remote 注入前不能执行关闭请求；就绪后统一冲刷，避免把启动竞态显示成永久错误。 */
  private cleanupQueued = false

  constructor(ctx: Context, private readonly remote: TerminalRemoteSource, private readonly t: CodingNsTranslator = resolveCodingNsTranslator()) {
    super(ctx, 'webTerminals')
    for (const request of readCloseRequests()) this.closeRequests.set(String(request.id), request)
    void this.flushCleanup()
  }

  view(sessionId: string, key: string, contentId: string, terminalId?: WebTerminalId, shellPath?: string, createFresh = false, persistBinding = true, keepAlive = false, initialState?: TerminalInitialState): CodingNsTerminalView {
    const mapKey = JSON.stringify([sessionId, key])
    const existing = this.views.get(mapKey)
    if (existing !== undefined) return existing.view
    const workspaceId = this.workspaceIds.get(sessionId)
    const sessionBinding = readBinding(sessionId, contentId)
    // “新建”是一次性动作：首次消费标记时忽略工作区单终端绑定，生成新的身份；
    // 标签重载后若已有会话绑定，则恢复刚创建的终端，避免再次创建重复进程。
    const fresh = createFresh && sessionBinding === undefined
    const saved = fresh
      ? terminalId
      : terminalId
        ?? sessionBinding
        ?? (workspaceId === undefined ? undefined : readWorkspaceBindingWithMigration(workspaceId, contentId))
    const id = saved ?? crypto.randomUUID() as WebTerminalId
    debugInfo('codingns4dsh: client terminal view', { sessionId, key, contentId, workspaceId: workspaceId ?? null, savedId: saved ?? null, terminalId: id, bindingSource: terminalId !== undefined ? 'argument' : workspaceId !== undefined && readWorkspaceBindingWithMigration(workspaceId, contentId) !== undefined ? 'workspace-storage' : readBinding(sessionId, contentId) !== undefined ? 'session-storage' : 'new' })
    if (persistBinding && (fresh || saved === undefined)) writeBinding(sessionId, contentId, id)
    const view = new CodingNsTerminalView(
      sessionId,
      id,
      this.remote,
      fresh || saved === undefined,
      shellPath,
      persistBinding
        ? (resolvedWorkspaceId, currentId) => this.rememberWorkspace(sessionId, contentId, currentId, resolvedWorkspaceId, !fresh && terminalId === undefined)
        : (resolvedWorkspaceId) => { this.workspaceIds.set(sessionId, resolvedWorkspaceId); return undefined },
      this.t,
      keepAlive,
      initialState,
    )
    this.views.set(mapKey, { contentId, view })
    return view
  }

  /** 聚合页按 Host terminalId 获取内部视图，不再依赖 Sidebar 标签身份。 */
  viewForTerminal(sessionId: string, terminalId: WebTerminalId, shellPath?: string): CodingNsTerminalView {
    const key = `aggregate:${terminalId}`
    const info = this.inventoryForSession(sessionId).find((item) => item.id === terminalId)
    const environment = this.environmentForSession(sessionId)
    const initialState: TerminalInitialState | undefined = info === undefined && environment === undefined
      ? undefined
      : {
        ...(info === undefined ? {} : { info }),
        ...(environment === undefined ? {} : { environment }),
      }
    return this.view(sessionId, key, key, terminalId, shellPath, false, false, true, initialState)
  }

  /** 返回某个 Sidebar 内容已经保存的 Host 终端身份，用于恢复时去重。 */
  boundTerminalId(sessionId: string, contentId: string): WebTerminalId | undefined {
    const workspaceId = this.workspaceIds.get(sessionId)
    return readBinding(sessionId, contentId)
      ?? (workspaceId === undefined ? undefined : readWorkspaceBindingWithMigration(workspaceId, contentId))
  }

  /**
   * 判断恢复阶段是否应保留某个标签。
   *
   * Host 列表为空有两种含义：新建终端的 create 还没有完成，或者 Host 已经
   * 关闭终端而 Sidebar 只剩残留标签。只有当前 Client 视图明确处于创建中或
   * 仍收到 Host 的 running 状态时，空列表才属于前一种情况。
   */
  isTerminalRecoveryProtected(sessionId: string, contentId: string, terminalId: WebTerminalId): boolean {
    for (const record of this.views.values()) {
      if (record.view.sessionId !== sessionId || record.contentId !== contentId) continue
      if (record.view.id !== terminalId) continue
      return record.view.isRecoveryProtected()
    }
    return false
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

  /** 在聚合页内创建一个新的 Host 终端，并把它加入工作区库存。 */
  async createTerminal(sessionId: string, shellPath?: string): Promise<WebTerminalInfo> {
    const terminalId = crypto.randomUUID() as WebTerminalId
    const view = this.view(sessionId, `aggregate:${terminalId}`, `aggregate:${terminalId}`, terminalId, shellPath, true, false, true)
    await view.refresh()
    const info = view.state.getSnapshot().info
    if (info === undefined) throw new Error(view.state.getSnapshot().error ?? '终端创建失败')
    await this.refreshInventory(sessionId)
    return info
  }

  /** 只关闭指定 terminalId；其他会话中对应的 attach 视图只做 detach。 */
  async closeTerminal(sessionId: string, terminalId: WebTerminalId): Promise<void> {
    const records = [...this.views.entries()].filter(([, record]) => record.view.id === terminalId)
    const primary = records.find(([, record]) => record.view.sessionId === sessionId)?.[1]
    if (primary !== undefined) await primary.view.close()
    else unwrap(await resolveRemote(this.remote).close(sessionId, terminalId))
    for (const [mapKey, record] of records) {
      this.views.delete(mapKey)
      // close() 只结束 Host 终端，dispose() 负责释放聚合视图保留的 follow。
      await record.view.dispose()
    }
    await this.refreshInventory(sessionId)
  }

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
      deleteWorkspaceBindingIfMatches(workspaceId, id)
      deleteLegacyWorkspaceBinding(workspaceId, contentId)
    }
    this.views.delete(mapKey)
    void this.cleanup(request, record?.view)
  }

  async recover(sessionId: string): Promise<readonly WebTerminalInfo[]> {
    const pending = this.recoveries.get(sessionId)
    if (pending !== undefined) return pending
    const requestId = (this.inventoryRequestIds.get(sessionId) ?? 0) + 1
    this.inventoryRequestIds.set(sessionId, requestId)
    const inventoryEpoch = this.inventoryEpoch
    // 官方 list wire 只有 sessionId；先用 agent-scoped environment 让 Host 解析工作区。
    // 使用可选变量避免 TS 将闭包中的自引用判定为“赋值前使用”；
    // Promise 创建后才会执行异步主体，因此运行时仍能安全比较身份。
    let recovery: Promise<readonly WebTerminalInfo[]> | undefined
    recovery = (async () => {
      const environment = await this.resolveEnvironment(sessionId)
      if (environment.workspaceId !== undefined) this.workspaceIds.set(sessionId, environment.workspaceId)
      const result = dedupeInventory(unwrap(await resolveRemote(this.remote).list(sessionId)))
      const currentRequestId = this.inventoryRequestIds.get(sessionId)
      if (currentRequestId !== requestId || this.inventoryEpoch !== inventoryEpoch) {
        // 工作区尚未解析时，刷新方无法提前把这个会话加入失效集合。
        // 旧 list 结果不能交给 Sidebar，否则关闭后的终端会被重新投影出来；
        // 让当前会话重新发起一轮查询，直到拿到刷新后的库存。
        debugInfo('codingns4dsh: client terminal recover stale retry', {
          sessionId,
          terminalIds: result.map((entry) => entry.id),
          requestId,
          currentRequestId,
          inventoryEpoch,
          currentInventoryEpoch: this.inventoryEpoch,
        })
        // 当前请求尚未进入 finally；先移除自身，才能让 retry 创建新一代
        // Promise，而不是再次命中这个仍在执行的旧请求。
        if (recovery !== undefined && this.recoveries.get(sessionId) === recovery) this.recoveries.delete(sessionId)
        return this.recover(sessionId)
      }
      debugInfo('codingns4dsh: client terminal recover', { sessionId, workspaceId: environment.workspaceId, terminalIds: result.map((entry) => entry.id) })
      this.rememberInventory(sessionId, result)
      return result
    })().finally(() => {
      if (recovery !== undefined && this.recoveries.get(sessionId) === recovery) this.recoveries.delete(sessionId)
    })
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
    this.inventories.clear()
    this.environments.clear()
    this.inventoryRequestIds.clear()
    this.inventoryEpoch = 0
  }

  /** 强制刷新当前会话对应工作区的库存。 */
  async refreshInventory(sessionId: string): Promise<readonly WebTerminalInfo[]> {
    this.inventoryEpoch += 1
    // 聚合页创建/关闭后必须绕过同一工作区所有会话的旧 list 请求；否则
    // 另一个会话的迟到响应仍可能把关闭后的终端写回共享库存。
    const workspaceId = this.workspaceIds.get(sessionId)
    const invalidated = new Set<string>()
    for (const [knownSessionId, knownWorkspaceId] of this.workspaceIds) {
      if (knownSessionId === sessionId || (workspaceId !== undefined && knownWorkspaceId === workspaceId)) {
        invalidated.add(knownSessionId)
      }
    }
    invalidated.add(sessionId)
    for (const knownSessionId of invalidated) this.invalidateRecovery(knownSessionId)
    return this.recover(sessionId)
  }

  /** 令指定会话尚未完成的库存请求失效，并清掉可复用的旧 Promise。 */
  private invalidateRecovery(sessionId: string): void {
    this.inventoryRequestIds.set(sessionId, (this.inventoryRequestIds.get(sessionId) ?? 0) + 1)
    this.recoveries.delete(sessionId)
  }

  private async resolveEnvironment(sessionId: string): Promise<TerminalEnvironment> {
    const cached = this.environments.get(`session:${sessionId}`)
    if (cached !== undefined) return cached
    const environment = unwrap(await resolveRemote(this.remote).environment(sessionId))
    this.environments.set(`session:${sessionId}`, environment)
    if (environment.workspaceId !== undefined) this.environments.set(`workspace:${environment.workspaceId}`, environment)
    return environment
  }

  private environmentForSession(sessionId: string): TerminalEnvironment | undefined {
    const session = this.environments.get(`session:${sessionId}`)
    if (session !== undefined) return session
    const workspaceId = this.workspaceIds.get(sessionId)
    return workspaceId === undefined ? undefined : this.environments.get(`workspace:${workspaceId}`)
  }

  /** 返回当前会话最近一次拿到的工作区库存；首次加载时为空。 */
  inventoryForSession(sessionId: string): readonly WebTerminalInfo[] {
    const workspaceId = this.workspaceIds.get(sessionId) ?? `session:${sessionId}`
    return this.inventories.get(workspaceId)?.terminals ?? []
  }

  private rememberWorkspace(sessionId: string, contentId: string, id: WebTerminalId, workspaceId: string, useWorkspaceBinding: boolean): WorkspaceBindingResolution {
    this.workspaceIds.set(sessionId, workspaceId)
    // 显式恢复和“新建”都必须保留自己的 terminalId；只有普通无参数入口
    // 才使用旧的单终端工作区绑定兼容行为。
    const existing = useWorkspaceBinding ? readWorkspaceBindingWithMigration(workspaceId, contentId) : undefined
    const resolvedId = existing ?? id
    // 修正首次渲染时已经写入的会话键，避免第二个会话继续携带临时 ID。
    writeBinding(sessionId, contentId, resolvedId)
    if (useWorkspaceBinding) {
      // 旧版本的工作区键带 contentId；统一重写成只含 Workspace ID 的新键。
      writeWorkspaceBinding(workspaceId, contentId, resolvedId)
      deleteLegacyWorkspaceBinding(workspaceId, contentId)
    }
    return { id: resolvedId, existing: existing !== undefined }
  }

  private rememberInventory(sessionId: string, terminals: readonly WebTerminalInfo[]): void {
    const workspaceId = this.workspaceIds.get(sessionId) ?? `session:${sessionId}`
    const normalized = dedupeInventory(terminals)
    const previous = this.inventories.get(workspaceId)
    if (previous !== undefined && sameInventory(previous.terminals, normalized)) return
    const revision = this.inventoryRevisionStore.getSnapshot() + 1
    this.inventories.set(workspaceId, { workspaceId, terminals: normalized, revision })
    this.inventoryRevisionStore.set(revision)
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
      // 兼容旧 Sidebar 的显式关闭路径：关闭成功后也必须刷新工作区库存，
      // 否则其他会话会继续看到已经关闭的终端记录。
      void this.refreshInventory(request.sessionId).catch((error: unknown) => {
        debugWarn('codingns4dsh: client terminal inventory refresh after close failed', {
          sessionId: request.sessionId,
          terminalId: request.id,
          error: errorMessage(error),
        })
      })
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

function sameInventory(left: readonly WebTerminalInfo[], right: readonly WebTerminalInfo[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (a.id !== b.id || a.title !== b.title || a.cwd !== b.cwd || a.cols !== b.cols || a.rows !== b.rows || a.state !== b.state || a.exitCode !== b.exitCode || a.shell.path !== b.shell.path || a.shell.name !== b.shell.name) return false
  }
  return true
}

/** Host 列表按 terminalId 去重，避免重复记录共享同一个关闭动作。 */
function dedupeInventory(terminals: readonly WebTerminalInfo[]): readonly WebTerminalInfo[] {
  const unique = new Map<WebTerminalId, WebTerminalInfo>()
  for (const terminal of terminals) unique.set(terminal.id, terminal)
  return [...unique.values()]
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

function deleteWorkspaceBindingIfMatches(workspaceId: string, id: WebTerminalId): void {
  if (readWorkspaceBinding(workspaceId) !== id) return
  deleteWorkspaceBinding(workspaceId)
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
