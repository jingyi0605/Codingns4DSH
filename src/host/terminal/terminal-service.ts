import { randomUUID } from 'node:crypto'
import type {
  CodingNsTerminalFrame,
  CodingNsTerminalRuntimeType,
  CodingNsTerminalShell,
  CodingNsWebTerminalInfo,
  PersistentTerminalRecord,
  TerminalOwnerScope,
  TerminalRecordIdentity,
} from '../../shared/contracts/terminal.js'
import type { TerminalRuntimeManager } from './runtime-manager.js'
import type { CodingNsTerminalStore } from './terminal-store.js'
import { debugInfo, debugWarn } from '../../shared/debug.js'

export interface CreatePersistentTerminalInput {
  readonly scope: TerminalOwnerScope
  readonly terminalId: string
  readonly runtimeType: CodingNsTerminalRuntimeType
  readonly shell: CodingNsTerminalShell
  /** 可选的业务标题；普通终端未提供时使用 Shell 名称。 */
  readonly title?: string
  readonly commandPath?: string
  readonly commandArgs?: readonly string[]
  readonly commandEnv?: Readonly<Record<string, string>>
  readonly launchProfileId?: string
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  /** 仅保存在当前 Host 内存中的运行时结束通知，不进入终端持久记录。 */
  readonly onExit?: (exitCode: number | null, kind: TerminalExitKind) => void | Promise<void>
}

/**
 * 持久运行时结束的语义。
 *
 * `exited` 表示 shell 真的结束并给出退出码；`lost` 表示运行时消失但没有可信的
 * 退出码（服务器被外部结束、socket 被清理）。连接层的断开不属于这里。
 */
export type TerminalExitKind = 'exited' | 'lost'

export interface FollowPersistentTerminalInput {
  readonly identity: TerminalRecordIdentity
  readonly attachmentId: string
  readonly generation: string
  readonly signal: AbortSignal
}

interface ControllerBinding {
  readonly attachmentId: string
  readonly subscriptionId: string
  readonly generation: string
}

/**
 * Host 侧常驻的运行时连接。
 *
 * 终端进程和终端连接是两件事。过去只有浏览器 follow 时才 attach backend，
 * 导致切换会话或重新挂载页面时每个终端都重新经历一次 connecting。现在每个
 * running 终端在 Host 内存中保留一条 attachment，浏览器只订阅这条连接的输出。
 */
interface ResidentConnection {
  readonly subscriptionId: string
  readonly runtimeAttachmentId: string
  readonly generation: string
  replay: string
}

interface ActiveFollower {
  readonly attachmentId: string
  readonly generation: string
  readonly queue: TerminalFrameQueue
}

/**
 * 持久终端生命周期服务。
 *
 * store 决定“终端是什么”，runtime manager 决定“当前如何连上它”。插件停用时
 * dispose 只释放后者；只有 close 会调用 backend.terminate。
 */
export class CodingNsTerminalService {
  private readonly controllers = new Map<string, Map<string, ControllerBinding>>()
  private readonly residents = new Map<string, ResidentConnection>()
  private readonly residentPromises = new Map<string, Promise<ResidentConnection>>()
  /** resident 断线重连期间暂存恢复任务，输入和 resize 必须等待它完成。 */
  private readonly residentRecoveryPromises = new Map<string, Promise<void>>()
  private readonly followers = new Map<string, Set<ActiveFollower>>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly exitCallbacks = new Map<string, (exitCode: number | null, kind: TerminalExitKind) => void | Promise<void>>()
  private readonly historyReflowTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private initialized = false

  constructor(
    private readonly store: CodingNsTerminalStore,
    private readonly runtimes: TerminalRuntimeManager,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.store.load()
    this.initialized = true
    debugInfo('codingns4dsh: terminal service initialized', {
      recordCount: this.store.list().length,
      records: this.store.list().map(recordSummary),
    })
  }

  supportsRuntimeType(runtimeType: CodingNsTerminalRuntimeType): boolean {
    return this.runtimes.supports(runtimeType)
  }

  resolveRuntimeType(runtimeType: CodingNsTerminalRuntimeType): CodingNsTerminalRuntimeType {
    if (this.runtimes.supports(runtimeType)) return runtimeType
    if (this.runtimes.supports('local-pty')) return 'local-pty'
    return runtimeType
  }

  list(scope: TerminalOwnerScope): readonly CodingNsWebTerminalInfo[] {
    this.requireInitialized()
    return this.store.list(scope)
      .filter((record) => record.state !== 'closed')
      .map((record) => this.info(record))
  }

  /** 兼容旧调用名；真正的持久归属只按 Host + workspace 查询。 */
  listSession(hostId: string, dshSessionId: string, workspaceId?: string): readonly CodingNsWebTerminalInfo[] {
    this.requireInitialized()
    if (workspaceId !== undefined) return this.listWorkspace(hostId, workspaceId)
    return this.store.list()
      .filter((record) => record.hostId === hostId && record.dshSessionId === dshSessionId && record.state !== 'closed')
      .map((record) => this.info(record))
  }

  listWorkspace(hostId: string, workspaceId: string): readonly CodingNsWebTerminalInfo[] {
    this.requireInitialized()
    return this.store.list({ hostId, workspaceId })
      .filter((record) => record.state !== 'closed')
      .map((record) => this.info(record))
  }

  findIdentity(hostId: string, dshSessionId: string, terminalId: string, workspaceId?: string): TerminalRecordIdentity {
    this.requireInitialized()
    const matches = this.store.list().filter((record) => record.hostId === hostId
      && (workspaceId === undefined ? record.dshSessionId === dshSessionId : record.workspaceId === workspaceId)
      && record.terminalId === terminalId
      && record.state !== 'closed')
    if (matches.length !== 1) throw new TerminalServiceError('TERMINAL_UNAVAILABLE', '终端不存在或作用域不唯一')
    const record = matches[0]!
    return {
      hostId: record.hostId,
      workspaceId: record.workspaceId,
      dshSessionId,
      terminalId: record.terminalId,
    }
  }

  async create(input: CreatePersistentTerminalInput): Promise<CodingNsWebTerminalInfo> {
    this.requireInitialized()
    validateTerminalId(input.terminalId)
    validateSize(input.cols, input.rows)
    const identity: TerminalRecordIdentity = { ...input.scope, terminalId: input.terminalId }
    debugInfo('codingns4dsh: terminal service create start', {
      identity,
      runtimeType: input.runtimeType,
      shellProfileId: input.shell.profileId,
      cols: input.cols,
      rows: input.rows,
    })
    return this.enqueue(identity, async () => {
      const existing = this.store.get(identity)
      debugInfo('codingns4dsh: terminal service create queued', {
        identity,
        existing: existing === undefined ? null : recordSummary(existing),
      })
      if (existing !== undefined) {
        if (existing.state === 'closed' || existing.state === 'closing') {
          throw new TerminalServiceError('TERMINAL_UNAVAILABLE', '终端已关闭，不能复用相同标识')
        }
        const runtime = await this.runtimes.inspect(existing)
        debugInfo('codingns4dsh: terminal service create existing inspect', {
          identity,
          record: recordSummary(existing),
          runtime: runtimeSummary(runtime),
        })
        if (runtime.alive) {
          const running = existing.state === 'running'
            ? existing
            : await this.update(existing, { state: 'running', error: '' })
          try { await this.ensureResident(running) } catch (error) {
            debugWarn('codingns4dsh: terminal resident connection warmup failed', {
              identity,
              error: errorMessage(error),
            })
          }
          return this.info(running)
        }
        // 运行时确实没了：同一个 terminalId 允许重建，这样 Sidebar 标签、标题和
        // 尺寸都能保留。旧实现只把记录标成 lost 再抛错，用户点"重建终端"永远失败。
        return this.rebuild(existing, input)
      }

      const timestamp = this.now().toISOString()
      const record: PersistentTerminalRecord = {
        ...input.scope,
        terminalId: input.terminalId,
        runtimeSessionKey: randomUUID(),
        runtimeType: input.runtimeType,
        shellPath: input.shell.path,
        shellProfileId: input.shell.profileId,
        shellName: input.shell.name,
        shellArgs: [...input.shell.args],
        ...(input.commandPath === undefined ? {} : { commandPath: input.commandPath }),
        ...(input.commandArgs === undefined ? {} : { commandArgs: [...input.commandArgs] }),
        ...(input.commandEnv === undefined ? {} : { commandEnv: { ...input.commandEnv } }),
        ...(input.launchProfileId === undefined ? {} : { launchProfileId: input.launchProfileId }),
        cwd: input.cwd,
        title: input.title?.trim() || input.shell.name,
        cols: input.cols,
        rows: input.rows,
        state: 'starting',
        exitCode: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      await this.store.put(record)
      debugInfo('codingns4dsh: terminal service record starting', { record: recordSummary(record) })
      try {
        const runtime = await this.runtimes.create(record)
        debugInfo('codingns4dsh: terminal service runtime created', {
          identity,
          runtime: runtimeSummary(runtime),
        })
        if (!runtime.alive) throw new Error('backend 创建后未报告存活状态')
        if (input.onExit !== undefined) this.exitCallbacks.set(identityKey(identity), input.onExit)
        const running = await this.update(record, { state: 'running', error: '' })
        // 常驻连接同时承担自然退出监听。这样普通终端和启动项终端都使用同一
        // 条 Host 内存连接，浏览器 follow 不再反复创建 backend attach。
        try { await this.ensureResident(running) } catch (error) {
          debugWarn('codingns4dsh: terminal resident connection warmup failed', {
            identity,
            error: errorMessage(error),
          })
        }
        debugInfo('codingns4dsh: terminal service create success', { record: recordSummary(running) })
        return this.info(running)
      } catch (error) {
        this.exitCallbacks.delete(identityKey(identity))
        const message = errorMessage(error)
        debugWarn('codingns4dsh: terminal service create failed', {
          identity,
          record: recordSummary(record),
          error: message,
        })
        await this.update(record, { state: 'error', error: message })
        throw error
      }
    })
  }

  /** 返回 Host 侧完整记录，供进程服务读取 runtimeSessionKey 和运行身份。 */
  getRecord(identity: TerminalRecordIdentity): PersistentTerminalRecord | undefined {
    this.requireInitialized()
    return this.store.get(identity)
  }

  /**
   * 用同一个 terminalId 重建已经丢失的运行时。
   *
   * 保留 cwd、标题、shell 与工作区归属，只换一个新的 runtimeSessionKey；旧的
   * tmux 会话/PTY 已经不存在，先按幂等方式清理一次再创建。
   */
  private async rebuild(
    existing: PersistentTerminalRecord,
    input: CreatePersistentTerminalInput,
  ): Promise<CodingNsWebTerminalInfo> {
    await this.update(existing, { state: 'lost', error: '持久终端运行时不存在' })
    // 重建会更换 runtimeSessionKey；旧 resident 即使 backend 已经丢失，也不能
    // 留在内存映射里，否则后面的 ensureResident 会把新终端绑定到旧订阅。
    await this.releaseResident(identityOfRecord(existing))
    try { await this.runtimes.terminate(existing) } catch { /* 旧运行时已经不存在 */ }
    await this.runtimes.detachTerminal(existing)
    this.exitCallbacks.delete(identityKey(existing))
    const identity: TerminalRecordIdentity = { ...input.scope, terminalId: existing.terminalId }
    const timestamp = this.now().toISOString()
    const record: PersistentTerminalRecord = {
      ...existing,
      ...input.scope,
      runtimeSessionKey: randomUUID(),
      runtimeType: input.runtimeType,
      shellPath: input.shell.path,
      shellProfileId: input.shell.profileId,
      shellName: input.shell.name,
      shellArgs: [...input.shell.args],
      ...(input.commandPath === undefined ? {} : { commandPath: input.commandPath }),
      ...(input.commandArgs === undefined ? {} : { commandArgs: [...input.commandArgs] }),
      ...(input.commandEnv === undefined ? {} : { commandEnv: { ...input.commandEnv } }),
      ...(input.launchProfileId === undefined ? {} : { launchProfileId: input.launchProfileId }),
      cwd: input.cwd,
      title: input.title?.trim() || existing.title,
      cols: input.cols,
      rows: input.rows,
      state: 'starting',
      exitCode: null,
      error: '',
      updatedAt: timestamp,
    }
    await this.store.put(record)
    try {
      const runtime = await this.runtimes.create(record)
      if (!runtime.alive) throw new Error('backend 重建后未报告存活状态')
      if (input.onExit !== undefined) this.exitCallbacks.set(identityKey(identity), input.onExit)
      const running = await this.update(record, { state: 'running', error: '' })
      try { await this.ensureResident(running) } catch (error) {
        debugWarn('codingns4dsh: terminal resident connection warmup failed', {
          identity,
          error: errorMessage(error),
        })
      }
      return this.info(running)
    } catch (error) {
      this.exitCallbacks.delete(identityKey(identity))
      await this.update(record, { state: 'error', error: errorMessage(error) })
      throw error
    }
  }

  async inspect(identity: TerminalRecordIdentity) {
    const record = this.getRecord(identity)
    if (record === undefined) throw new TerminalServiceError('TERMINAL_UNAVAILABLE', '终端不存在')
    return this.runtimes.inspect(record)
  }

  async recover(): Promise<void> {
    this.requireInitialized()
    for (const record of this.store.list()) {
      if (record.state === 'closed' || record.state === 'exited') continue
      await this.enqueue(record, async () => {
        const current = this.store.get(record)
        if (current === undefined || current.state === 'closed') return
        if (current.state === 'closing') {
          await this.releaseResident(identityOfRecord(current))
          await this.runtimes.terminate(current)
          await this.runtimes.detachTerminal(current)
          await this.update(current, { state: 'closed', exitCode: null, error: '' })
          return
        }
        try {
          const identity = await this.runtimes.inspect(current)
          if (identity.alive) {
            await this.update(current, { state: 'running', error: '' })
            // 恢复阶段提前建立常驻连接，用户第一次点击终端时直接收到已有状态。
            try { await this.ensureResident(this.store.get(current) ?? current) } catch (error) {
              debugWarn('codingns4dsh: terminal resident connection restore failed', {
                identity: identityOfRecord(current),
                error: errorMessage(error),
              })
            }
            return
          }
          // 运行时不在了：有真实退出码才算 exited，否则只能报告 lost。
          // 少了这一步，DSH 重启后会把"用户已经退出的终端"一直显示成丢失。
          await this.update(current, identity.exitCode === undefined || identity.exitCode === null
            ? { state: 'lost', exitCode: null, error: identity.detail ?? '持久终端运行时不存在' }
            : { state: 'exited', exitCode: identity.exitCode, error: '' })
        } catch (error) {
          await this.update(current, { state: 'error', error: errorMessage(error) })
        }
      })
    }
  }

  async *retain(identity: TerminalRecordIdentity, signal: AbortSignal): AsyncIterable<{ type: 'retained' }> {
    this.requireAvailable(identity)
    signal.throwIfAborted()
    yield { type: 'retained' }
    await untilAborted(signal)
  }

  async *follow(input: FollowPersistentTerminalInput): AsyncIterable<CodingNsTerminalFrame> {
    const record = this.requireAvailable(input.identity)
    debugInfo('codingns4dsh: terminal service follow start', {
      identity: input.identity,
      attachmentId: input.attachmentId,
      generation: input.generation,
      record: recordSummary(record),
    })
    const key = identityKey(input.identity)
    // create/recover 通常已经建立 resident；旧记录或连接抖动时在这里补建一次。
    await this.ensureResident(record)
    const resident = this.residents.get(key)
    if (resident === undefined) throw new TerminalServiceError('TERMINAL_RUNTIME_LOST', '终端常驻连接不可用')
    const queue = new TerminalFrameQueue(2 * 1024 * 1024)
    const follower: ActiveFollower = { attachmentId: input.attachmentId, generation: input.generation, queue }
    // resident 已经存在时不再等待 backend attach；先从 tmux server 读取完整历史，
    // 这样第一帧能真正填充 xterm scrollback，而不是只重放当前屏幕。
    // 如果把它当作 output 增量发送，切换会话或 resident 重连时会把整屏再次追加，
    // 造成 prompt 重复和 ANSI 内容错位。
    let snapshot = resident.replay
    try {
      const captured = await this.runtimes.captureHistory(record, RESIDENT_HISTORY_LINES)
      if (captured !== undefined) {
        resident.replay = captured
        snapshot = captured
        debugInfo('codingns4dsh: terminal history snapshot ready', {
          identity: input.identity,
          source: 'runtime-capture',
          historyLines: countLines(captured),
          historyCharacters: captured.length,
        })
      } else {
        debugInfo('codingns4dsh: terminal history snapshot fallback', {
          identity: input.identity,
          source: 'resident-replay',
          replayCharacters: snapshot.length,
        })
      }
    } catch (error) {
      debugWarn('codingns4dsh: terminal history capture failed, using resident replay', {
        identity: input.identity,
        error: errorMessage(error),
        replayCharacters: snapshot.length,
      })
    }
    // 历史读取期间不登记 follower，避免极短竞态把 output 排在 snapshot 之前。
    snapshot = resident.replay
    this.addFollower(key, follower)
    this.addController(key, input.attachmentId, {
      attachmentId: input.attachmentId,
      subscriptionId: resident.subscriptionId,
      generation: input.generation,
    })
    queue.pushSnapshot(this.info(record, input.attachmentId), snapshot)
    queue.pushState(this.info(record, input.attachmentId))
    try {
      debugInfo('codingns4dsh: terminal service follow subscribed', {
        identity: input.identity,
        attachmentId: input.attachmentId,
        residentSubscriptionId: resident.subscriptionId,
        residentRuntimeAttachmentId: resident.runtimeAttachmentId,
      })
      const abort = (): void => queue.finish()
      input.signal.addEventListener('abort', abort, { once: true })
      if (input.signal.aborted) abort()
      yield* queue.read()
      input.signal.removeEventListener('abort', abort)
    } finally {
      this.removeFollower(key, follower)
      this.removeController(key, input.attachmentId)
      debugInfo('codingns4dsh: terminal service follow unsubscribed', {
        identity: input.identity,
        attachmentId: input.attachmentId,
        residentSubscriptionId: resident.subscriptionId,
      })
    }
  }

  async write(identity: TerminalRecordIdentity, attachmentId: string, data: string): Promise<void> {
    const controller = await this.waitForController(identity, attachmentId)
    await this.runtimes.write(controller.subscriptionId, data)
  }

  /** Host 内部向持久终端发送一次输入，不改变浏览器 attach 控制权。 */
  async writeInitialInput(identity: TerminalRecordIdentity, data: string): Promise<void> {
    if (data.length === 0) throw new TypeError('终端输入不能为空')
    this.requireInitialized()
    await this.enqueue(identity, async () => {
      const record = this.requireAvailable(identity)
      const resident = this.residents.get(identityKey(identity))
      if (resident !== undefined) {
        await this.runtimes.write(resident.subscriptionId, data)
        return
      }
      await this.runtimes.writeSession(record, data)
    })
  }

  async resize(identity: TerminalRecordIdentity, attachmentId: string, cols: number, rows: number): Promise<void> {
    validateSize(cols, rows)
    const controller = await this.waitForController(identity, attachmentId)
    const record = this.requireAvailable(identity)
    // ResizeObserver 可能重复报告同一尺寸；相同尺寸不应再次向 PTY 发送 SIGWINCH。
    if (record.cols === cols && record.rows === rows) return
    // 列宽变化必然改变 tmux 后续输出的换行；行数的大幅变化（移动端虚拟键盘收放、
    // 拖拽窗口高度）同样会让 tmux 把可见区域按旧列宽的历史物理行重新光栅化给
    // 客户端，覆盖上一次重排的结果，屏幕底部会残留旧列宽的“提前换行”行。两种
    // 变化都要调度一次历史重排（防抖合并），让重排放置在最后一次屏幕重绘之后；
    // ±1 行的可视区域抖动（移动端地址栏收放）不重排，避免频繁重置浏览位置。
    const widthChanged = record.cols !== cols
    const rowsDelta = Math.abs(record.rows - rows)
    await this.runtimes.resize(controller.subscriptionId, cols, rows)
    await this.update(record, { cols, rows })
    this.broadcastState(identity)
    if (widthChanged || rowsDelta >= TERMINAL_REFLOW_ROWS_THRESHOLD) this.scheduleHistoryReflow(identity)
  }

  /**
   * tmux 只会按新宽度渲染后续输出，不会重排已有内容；浏览器端 xterm 收到的
   * tmux 重绘行是逐行光栅化的，也不带可重排的换行标记。窗口宽度变化后必须
   * 重新用 capture-pane -J 把历史合并成长逻辑行再重放，客户端才会按新列宽
   * 整体重排，否则历史行永远停在旧宽度、右侧留白。
   */
  private scheduleHistoryReflow(identity: TerminalRecordIdentity): void {
    const key = identityKey(identity)
    const pending = this.historyReflowTimers.get(key)
    if (pending !== undefined) clearTimeout(pending)
    const timer = setTimeout(() => {
      this.historyReflowTimers.delete(key)
      void this.reflowHistory(identity)
    }, HISTORY_REFLOW_DEBOUNCE_MS)
    this.historyReflowTimers.set(key, timer)
  }

  private async reflowHistory(identity: TerminalRecordIdentity): Promise<void> {
    const key = identityKey(identity)
    if ((this.followers.get(key)?.size ?? 0) === 0) return
    const record = this.store.get(identity)
    if (record === undefined || record.state !== 'running') return
    try {
      const captured = await this.runtimes.captureHistory(record, RESIDENT_HISTORY_LINES)
      if (captured === undefined) return
      const current = this.store.get(identity)
      if (current === undefined || current.state !== 'running') return
      const resident = this.residents.get(key)
      if (resident !== undefined) resident.replay = captured
      for (const follower of this.followers.get(key) ?? []) {
        follower.queue.pushSnapshot(this.info(current, follower.attachmentId), captured)
      }
      debugInfo('codingns4dsh: terminal history reflow snapshot pushed', {
        identity,
        cols: current.cols,
        historyLines: countLines(captured),
        historyCharacters: captured.length,
      })
    } catch (error) {
      debugWarn('codingns4dsh: terminal history reflow failed', {
        identity,
        error: errorMessage(error),
      })
    }
  }

  async rename(identity: TerminalRecordIdentity, title: string): Promise<void> {
    const normalized = title.trim()
    if (normalized.length === 0 || normalized.length > 120) throw new TypeError('终端标题必须包含 1 到 120 个字符')
    const record = this.requireAvailable(identity)
    await this.update(record, { title: normalized })
    this.broadcastState(identity)
  }

  async close(identity: TerminalRecordIdentity): Promise<void> {
    this.requireInitialized()
    debugInfo('codingns4dsh: terminal service close start', { identity })
    await this.enqueue(identity, async () => {
      const record = this.store.get(identity)
      if (record === undefined || record.state === 'closed') {
        debugInfo('codingns4dsh: terminal service close noop', { identity, record: record === undefined ? null : recordSummary(record) })
        return
      }
      const closing = record.state === 'closing' ? record : await this.update(record, { state: 'closing' })
      this.broadcastState(identity)
      await this.releaseResident(identity)
      await this.runtimes.terminate(closing)
      debugInfo('codingns4dsh: terminal service runtime terminated', { identity, record: recordSummary(closing) })
      await this.runtimes.detachTerminal(identity)
      this.controllers.delete(identityKey(identity))
      this.exitCallbacks.delete(identityKey(identity))
      const closed = await this.update(closing, { state: 'closed', exitCode: null, error: '' })
      this.broadcastState(identity, closed)
      this.finishFollowers(identityKey(identity))
      debugInfo('codingns4dsh: terminal service close success', { identity, record: recordSummary(closed) })
    })
  }

  async detachGeneration(generation: string): Promise<void> {
    // 浏览器 attach 已经只是 resident 的订阅，不再拥有 backend attachment；
    // RuntimeManager 的 generation 清理仍保留，用于兼容旧的 monitor/调用方。
    await this.runtimes.detachGeneration(generation)
    const changed = new Set<string>()
    for (const [key, bindings] of this.controllers) {
      for (const [attachmentId, binding] of bindings) {
        if (binding.generation !== generation) continue
        bindings.delete(attachmentId)
        changed.add(key)
      }
      if (bindings.size === 0) this.controllers.delete(key)
    }
    for (const [key, followers] of this.followers) {
      for (const follower of followers) {
        if (follower.generation === generation) follower.queue.finish()
      }
      if ([...followers].some((follower) => follower.generation === generation)) changed.add(key)
    }
    for (const key of changed) this.broadcastStateByKey(key)
  }

  /** 插件卸载只断开 attach，持久 backend 必须继续运行。 */
  async dispose(): Promise<void> {
    for (const timer of this.historyReflowTimers.values()) clearTimeout(timer)
    this.historyReflowTimers.clear()
    for (const followers of this.followers.values()) for (const follower of followers) follower.queue.finish()
    this.followers.clear()
    this.controllers.clear()
    this.residentRecoveryPromises.clear()
    this.residents.clear()
    this.exitCallbacks.clear()
    await this.runtimes.dispose()
  }

  /**
   * resident 重连会短暂撤销旧 subscription 的控制权。
   *
   * 这不是用户失去输入权限，而是 Host 正在把同一持久终端重新挂回新连接。
   * 等待这次恢复可以消除输入请求与控制权重绑之间的竞态，避免客户端收到一条
   * 会永久留在界面底部的假错误。
   */
  private async waitForController(identity: TerminalRecordIdentity, attachmentId: string): Promise<ControllerBinding> {
    this.requireAvailable(identity)
    const key = identityKey(identity)
    let controller = this.controllers.get(key)?.get(attachmentId)
    const recovery = this.residentRecoveryPromises.get(key)
    if (controller === undefined && recovery !== undefined) {
      try { await recovery } catch { /* 恢复失败时由下面的统一错误收敛 */ }
      controller = this.controllers.get(key)?.get(attachmentId)
    }
    this.requireAvailable(identity)
    if (controller === undefined) {
      throw new TerminalServiceError('TERMINAL_CONTROL_UNAVAILABLE', '当前 attach 没有终端输入控制权')
    }
    return controller
  }

  private requireAvailable(identity: TerminalRecordIdentity): PersistentTerminalRecord {
    this.requireInitialized()
    const record = this.store.get(identity)
    if (record === undefined || record.state !== 'running') {
      throw new TerminalServiceError('TERMINAL_UNAVAILABLE', '终端不存在或当前不可用')
    }
    return record
  }

  private async refreshRuntimeState(identity: TerminalRecordIdentity): Promise<void> {
    const record = this.store.get(identity)
    if (record === undefined || record.state !== 'running') return
    try {
      const runtime = await this.runtimes.inspect(record)
      if (!runtime.alive) {
        const lost = await this.update(record, { state: 'lost', error: runtime.detail ?? '持久终端运行时不存在' })
        this.broadcastState(identity, lost)
      }
    } catch (error) {
      const failed = await this.update(record, { state: 'error', error: errorMessage(error) })
      this.broadcastState(identity, failed)
    }
  }

  /**
   * 浏览器 attach 客户端结束了。
   *
   * tmux 客户端在"服务器消失""会话被销毁""只是这次连接断了"时都会退出，退出码
   * 本身不能证明 shell 结束。因此这里必须回查运行时的真实状态：只有确实拿到
   * shell 的退出码才算 `exited`，否则只能标记 `lost`，让用户重新连接而不是看到
   * 一个假的"进程已退出（1）"。
   */
  private async handleAttachmentExit(
    identity: TerminalRecordIdentity,
    exitCode: number | null,
    queue: TerminalFrameQueue,
  ): Promise<void> {
    try {
      await this.finishRuntime(identity, exitCode)
    } finally {
      // 先发终态元数据，再结束 Remote 流；否则官方 Client 会把正常退出误判为 attach 故障。
      queue.finish()
    }
  }

  /** 以运行时的实际状态收尾：能确认真实退出码才算 exited，否则是 lost。 */
  private async finishRuntime(identity: TerminalRecordIdentity, exitCode: number | null): Promise<void> {
    debugInfo('codingns4dsh: terminal service runtime exit observed', { identity, callbackExitCode: exitCode })
    await this.enqueue(identity, async () => {
      const record = this.store.get(identity)
      if (record === undefined || record.state !== 'running') return
      let runtime
      try {
        runtime = await this.runtimes.inspect(record)
      } catch (error) {
        const failed = await this.update(record, { state: 'error', error: errorMessage(error) })
        this.broadcastState(identity, failed)
        return
      }
      debugInfo('codingns4dsh: terminal service runtime exit inspect', {
        identity,
        record: recordSummary(record),
        runtime: runtimeSummary(runtime),
      })
      if (runtime.alive) return
      const confirmed = runtime.exitCode ?? null
      const kind: TerminalExitKind = runtime.exitCode === undefined || runtime.exitCode === null ? 'lost' : 'exited'
      const finished = kind === 'exited'
        ? await this.update(record, { state: 'exited', exitCode: confirmed, error: '' })
        : await this.update(record, {
          state: 'lost',
          exitCode: null,
          error: runtime.detail ?? `持久终端连接中断（客户端退出码 ${exitCode ?? '未知'}）`,
        })
      this.broadcastState(identity, finished)
      const callback = this.exitCallbacks.get(identityKey(identity))
      this.exitCallbacks.delete(identityKey(identity))
      await callback?.(confirmed, kind)
      debugInfo('codingns4dsh: terminal service runtime finalized', {
        identity,
        kind,
        record: recordSummary(finished),
      })
    })
  }

  private info(record: PersistentTerminalRecord, controllerId?: string): CodingNsWebTerminalInfo {
    const state = record.state === 'running' || record.state === 'starting'
      ? 'running'
      : record.state === 'closed' || record.state === 'exited'
        ? 'exited'
        : record.state === 'lost'
          ? 'lost'
          : 'failed'
    return {
      id: record.terminalId,
      title: record.title,
      shell: shellInfo(record),
      cwd: record.cwd,
      cols: record.cols,
      rows: record.rows,
      state,
      exitCode: record.exitCode,
      ...(record.error && record.state !== 'closed' ? { error: record.error } : {}),
      ...(controllerId === undefined ? {} : { controllerId }),
    }
  }

  /**
   * 确保一个终端只有一条 Host backend attachment。
   *
   * 这个连接不绑定某个浏览器 generation，直到显式 close 或 Host dispose 才释放。
   * 多个会话的 follow 都复用同一条连接，避免每次点击都重新启动 tmux client/PTY。
   */
  private async ensureResident(record: PersistentTerminalRecord): Promise<ResidentConnection> {
    const key = identityKey(record)
    const existing = this.residents.get(key)
    if (existing !== undefined) return existing
    const pending = this.residentPromises.get(key)
    if (pending !== undefined) return pending
    const identity = identityOfRecord(record)
    // 每次 resident 都使用独立 token。旧 backend attachment 的迟到回调不能
    // 误删同一 terminalId 后面刚重建的新 resident。
    const generation = `host-resident:${key}:${randomUUID()}`
    const requestedAttachmentId = `resident:${record.terminalId}`
    // resident 断线重连时，tmux attach 的首批输出是整屏重绘；它可能在
    // backend.attach 返回后异步到达，不能只依赖 runtime-manager 的 earlyData。
    // 在短暂启动窗口内先收集，随后以 snapshot 发给已有 follower。
    const hadFollowers = (this.followers.get(key)?.size ?? 0) > 0
    // attach 尚未完成时先无限期收集 earlyData；真正的窗口从 attachment
    // 建立后开始计算，避免慢机器上首屏在 100ms 后才到达而被误当增量。
    let bootstrapDeadline = Number.POSITIVE_INFINITY
    let bootstrapReplay = ''
    let replay = ''
    let task: Promise<ResidentConnection>
    task = this.runtimes.attach(record, {
      identity,
      generation,
      streamId: requestedAttachmentId,
      requestedAttachmentId,
      cols: record.cols,
      rows: record.rows,
      onData: (data) => {
        replay = boundedAppend(replay, data)
        const resident = this.residents.get(key)
        if (resident !== undefined) resident.replay = replay
        if (hadFollowers && Date.now() < bootstrapDeadline) {
          bootstrapReplay = boundedAppend(bootstrapReplay, data)
          return
        }
        this.broadcastOutput(key, data)
      },
      onExit: (exitCode) => { void this.handleResidentExit(identity, generation, exitCode) },
    }).then(async (attachment) => {
      const resident: ResidentConnection = {
        subscriptionId: attachment.subscriptionId,
        runtimeAttachmentId: attachment.runtimeAttachmentId,
        generation,
        replay,
      }
      this.residents.set(key, resident)
      // tmux attach 的原始 ANSI 首屏不含 scrollback；把 server buffer 的纯文本历史
      // 作为恢复快照，后续 output 仍由常驻连接增量推送。
      try {
        const captured = await this.runtimes.captureHistory(record, RESIDENT_HISTORY_LINES)
        if (captured !== undefined) {
          replay = captured
          resident.replay = captured
          debugInfo('codingns4dsh: terminal resident history captured', {
            identity,
            historyLines: countLines(captured),
            historyCharacters: captured.length,
          })
        }
      } catch (error) {
        debugWarn('codingns4dsh: terminal resident history capture failed', {
          identity,
          error: errorMessage(error),
        })
      }
      bootstrapDeadline = Date.now() + RESIDENT_BOOTSTRAP_WINDOW_MS
      if (hadFollowers) {
        // 等待 tmux attach 的初始整屏重绘收齐，再替换已有 xterm 画面。
        // 新 follow 不走这里，它会直接收到上面的 snapshot。
        setTimeout(() => {
          const current = this.residents.get(key)
          if (current?.generation !== generation || bootstrapReplay === '') return
          const currentRecord = this.store.get(identity)
          if (currentRecord === undefined || currentRecord.state !== 'running') return
          for (const follower of this.followers.get(key) ?? []) {
            follower.queue.pushSnapshot(this.info(currentRecord, follower.attachmentId), current.replay)
          }
          debugInfo('codingns4dsh: terminal resident bootstrap replay promoted to snapshot', {
            identity,
            generation,
            replayCharacters: current.replay.length,
          })
        }, RESIDENT_BOOTSTRAP_WINDOW_MS)
      }
      debugInfo('codingns4dsh: terminal resident connection ready', {
        identity,
        subscriptionId: resident.subscriptionId,
        runtimeAttachmentId: resident.runtimeAttachmentId,
        generation,
      })
      return resident
    }).finally(() => {
      if (this.residentPromises.get(key) === task) this.residentPromises.delete(key)
    })
    this.residentPromises.set(key, task)
    return task
  }

  private async releaseResident(identity: TerminalRecordIdentity): Promise<void> {
    const key = identityKey(identity)
    const pending = this.residentPromises.get(key)
    if (pending !== undefined) {
      try { await pending } catch { /* 创建失败时没有可释放的连接 */ }
    }
    const resident = this.residents.get(key)
    if (resident === undefined) return
    this.residents.delete(key)
    await this.runtimes.detach(resident.subscriptionId)
    debugInfo('codingns4dsh: terminal resident connection released', {
      identity,
      subscriptionId: resident.subscriptionId,
      runtimeAttachmentId: resident.runtimeAttachmentId,
    })
  }

  private async handleResidentExit(identity: TerminalRecordIdentity, generation: string, exitCode: number | null): Promise<void> {
    const key = identityKey(identity)
    const resident = this.residents.get(key)
    if (resident === undefined || resident.generation !== generation) {
      debugInfo('codingns4dsh: terminal resident stale exit ignored', {
        identity,
        generation,
        currentGeneration: resident?.generation ?? null,
        exitCode,
      })
      return
    }
    this.residents.delete(key)
    // 这条 backend 连接已经不能继续向浏览器送数据。先撤销输入控制权；
    // 是否结束订阅要等 finishRuntime 判断出“连接断开”还是“Shell 退出”之后决定。
    this.controllers.delete(key)
    const recovery = this.recoverResidentAfterExit(identity, key, resident.subscriptionId, exitCode)
    this.residentRecoveryPromises.set(key, recovery)
    try {
      await recovery
    } finally {
      if (this.residentRecoveryPromises.get(key) === recovery) this.residentRecoveryPromises.delete(key)
    }
  }

  /** 断线后确认运行时状态，并在仍存活时重建 resident 与浏览器控制权。 */
  private async recoverResidentAfterExit(identity: TerminalRecordIdentity, key: string, subscriptionId: string, exitCode: number | null): Promise<void> {
    try { await this.runtimes.detach(subscriptionId) } catch { /* backend 已经回收 attachment */ }
    await this.finishRuntime(identity, exitCode)
    const current = this.store.get(identity)
    if (current?.state === 'running') {
      // tmux client 断线不等于 Shell 结束。连接层恢复时保留已有 follower，
      // 重新建立 resident；真正退出则由 finishRuntime 收敛并结束所有订阅。
      try {
        const nextResident = await this.ensureResident(current)
        // resident 重建后 subscriptionId 已变化，原 follower 仍然有效，必须
        // 重新绑定它们的输入与 resize 控制权。
        for (const follower of this.followers.get(key) ?? []) {
          this.addController(key, follower.attachmentId, {
            attachmentId: follower.attachmentId,
            subscriptionId: nextResident.subscriptionId,
            generation: follower.generation,
          })
        }
        debugInfo('codingns4dsh: terminal resident connection reattached', {
          identity,
          subscriptionId: nextResident.subscriptionId,
        })
        return
      } catch (error) {
        debugWarn('codingns4dsh: terminal resident connection reattach failed', {
          identity,
          error: errorMessage(error),
        })
      }
    }
    // finishRuntime 已经把 exited/lost 状态推入队列，队列此时才可结束，
    // 保证 Client 先收到终态再看到流结束。
    this.finishFollowers(key)
  }

  private async update(
    record: PersistentTerminalRecord,
    patch: Partial<Pick<PersistentTerminalRecord, 'state' | 'title' | 'cols' | 'rows' | 'exitCode' | 'error'>>,
  ): Promise<PersistentTerminalRecord> {
    const next = await this.store.patch(record, { ...patch, updatedAt: this.now().toISOString() })
    if (next === undefined) throw new Error('终端记录在更新期间消失')
    if (record.state !== next.state || patch.error !== undefined || patch.exitCode !== undefined) {
      debugInfo('codingns4dsh: terminal service state update', {
        identity: identityOfRecord(record),
        before: recordSummary(record),
        patch,
        after: recordSummary(next),
      })
    }
    return next
  }

  private broadcastState(identity: TerminalRecordIdentity, record = this.store.get(identity)): void {
    if (record === undefined) return
    for (const follower of this.followers.get(identityKey(identity)) ?? []) {
      follower.queue.pushState(this.info(record, follower.attachmentId))
    }
  }

  private broadcastStateByKey(key: string): void {
    const record = this.store.list().find((candidate) => identityKey(candidate) === key)
    if (record !== undefined) this.broadcastState(record, record)
  }

  private addFollower(key: string, follower: ActiveFollower): void {
    let followers = this.followers.get(key)
    if (followers === undefined) {
      followers = new Set()
      this.followers.set(key, followers)
    }
    followers.add(follower)
  }

  private addController(key: string, attachmentId: string, binding: ControllerBinding): void {
    let bindings = this.controllers.get(key)
    if (bindings === undefined) {
      bindings = new Map()
      this.controllers.set(key, bindings)
    }
    bindings.set(attachmentId, binding)
  }

  private removeController(key: string, attachmentId: string): void {
    const bindings = this.controllers.get(key)
    if (bindings === undefined) return
    bindings.delete(attachmentId)
    if (bindings.size === 0) this.controllers.delete(key)
  }

  private broadcastOutput(key: string, data: string): void {
    for (const follower of this.followers.get(key) ?? []) follower.queue.pushOutput(data)
  }

  private removeFollower(key: string, follower: ActiveFollower): void {
    const followers = this.followers.get(key)
    followers?.delete(follower)
    if (followers?.size === 0) this.followers.delete(key)
  }

  private finishFollowers(key: string): void {
    for (const follower of this.followers.get(key) ?? []) follower.queue.finish()
  }

  private enqueue<T>(identity: TerminalRecordIdentity, operation: () => Promise<T>): Promise<T> {
    const key = identityKey(identity)
    const previous = this.operations.get(key) ?? Promise.resolve()
    const pending = previous.then(operation, operation)
    const tail = pending.then(() => undefined, () => undefined)
    this.operations.set(key, tail)
    void tail.finally(() => {
      if (this.operations.get(key) === tail) this.operations.delete(key)
    })
    return pending
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('终端服务尚未初始化')
  }
}

export type TerminalServiceErrorCode =
  | 'TERMINAL_UNAVAILABLE'
  | 'TERMINAL_CONTROL_UNAVAILABLE'
  | 'TERMINAL_RUNTIME_LOST'

export class TerminalServiceError extends Error {
  constructor(readonly code: TerminalServiceErrorCode, message: string) {
    super(message)
    this.name = 'TerminalServiceError'
  }
}

class TerminalFrameQueue {
  private readonly frames: CodingNsTerminalFrame[] = []
  private bytes = 0
  private sequence = 0
  private wake: (() => void) | undefined
  private ended = false
  private failure: Error | undefined

  constructor(private readonly maxBytes: number) {}

  pushSnapshot(info: CodingNsWebTerminalInfo, screen = ''): void {
    // tmux capture-pane 返回纯文本 LF；xterm 的真实 PTY 模式不会自动把 LF
    // 转成 CRLF，必须在 wire 边界补回 CR，否则历史行会逐行继承上一行的列位置。
    this.push({ type: 'snapshot', sequence: this.sequence, screen: normalizeSnapshotLineEndings(screen), info })
  }

  pushOutput(data: string): void {
    this.sequence += 1
    // 增量 PTY 输出保留原始 VT 语义；只有 capture-pane 的纯文本快照需要补 CR。
    this.push({ type: 'output', sequence: this.sequence, data })
  }

  pushState(info: CodingNsWebTerminalInfo): void {
    this.push({ type: 'state', info })
  }

  finish(): void {
    this.ended = true
    this.wake?.()
  }

  async *read(): AsyncIterable<CodingNsTerminalFrame> {
    while (!this.ended || this.frames.length > 0) {
      const frame = this.frames.shift()
      if (frame !== undefined) {
        this.bytes -= frameBytes(frame)
        yield frame
        continue
      }
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
    if (this.failure !== undefined) throw this.failure
  }

  private push(frame: CodingNsTerminalFrame): void {
    if (this.ended) return
    const bytes = frameBytes(frame)
    if (this.bytes + bytes > this.maxBytes) {
      this.failure = new Error('终端输出消费者超过缓冲上限，请重新连接以恢复当前屏幕')
      this.frames.length = 0
      this.bytes = 0
      this.finish()
      return
    }
    this.frames.push(frame)
    this.bytes += bytes
    this.wake?.()
  }
}

function shellInfo(record: PersistentTerminalRecord): CodingNsTerminalShell {
  const profileId = record.shellProfileId ?? (record.runtimeType === 'tmux'
    ? record.shellPath.endsWith('/bash') ? 'bash' : 'zsh'
    : record.runtimeType === 'conpty-cmd'
      ? 'cmd'
      : record.runtimeType === 'conpty-git-bash'
        ? 'git-bash'
        : 'powershell')
  return {
    profileId,
    path: record.shellPath,
    args: record.shellArgs ?? (profileId === 'cmd' ? [] : profileId === 'powershell' ? ['-NoLogo'] : ['-i']),
    name: record.shellName ?? profileId,
  }
}

function identityKey(identity: TerminalRecordIdentity): string {
  return JSON.stringify([identity.hostId, identity.workspaceId, identity.terminalId])
}

function identityOfRecord(record: PersistentTerminalRecord): TerminalRecordIdentity {
  return {
    hostId: record.hostId,
    workspaceId: record.workspaceId,
    terminalId: record.terminalId,
  }
}

function recordSummary(record: PersistentTerminalRecord): Record<string, unknown> {
  return {
    ...identityOfRecord(record),
    dshSessionId: record.dshSessionId ?? null,
    runtimeSessionKey: record.runtimeSessionKey,
    runtimeType: record.runtimeType,
    state: record.state,
    exitCode: record.exitCode,
    error: record.error || null,
  }
}

function runtimeSummary(runtime: { readonly alive: boolean; readonly runtimePid?: number | null; readonly shellPid?: number | null; readonly exitCode?: number | null; readonly detail?: string }): Record<string, unknown> {
  return {
    alive: runtime.alive,
    runtimePid: runtime.runtimePid ?? null,
    shellPid: runtime.shellPid ?? null,
    exitCode: runtime.exitCode ?? null,
    detail: runtime.detail ?? null,
  }
}

function validateTerminalId(id: string): void {
  if (!/^[\w-]{1,128}$/u.test(id)) throw new TypeError('终端标识无效')
}

function validateSize(cols: number, rows: number): void {
  if (!Number.isSafeInteger(cols) || cols < 2 || cols > 500 || !Number.isSafeInteger(rows) || rows < 1 || rows > 300) {
    throw new TypeError('终端尺寸超过允许范围')
  }
}

function frameBytes(frame: CodingNsTerminalFrame): number {
  return new TextEncoder().encode(JSON.stringify(frame)).byteLength
}

function normalizeSnapshotLineEndings(value: string): string {
  return value.replace(/\r?\n/gu, '\r\n')
}

/** 常驻连接只保留有限的原始输出，避免长期运行终端无限增长。 */
const MAX_RESIDENT_REPLAY_CHARACTERS = 1024 * 1024

/** tmux attach 的首屏通常在一个很短的窗口内分片送达。 */
const RESIDENT_BOOTSTRAP_WINDOW_MS = 100
/** 初次恢复读取的 tmux 历史行数；xterm 会再按自身 scrollback 上限裁剪。 */
const RESIDENT_HISTORY_LINES = 2000
/**
 * 拖拽窗口/键盘动画会连续触发 resize；合并成一次历史重放，避免反复重放整块历史。
 *
 * 该值同时决定“尺寸变化结束”到“重放送达”的间隔：期间客户端显示的是 tmux 重绘的
 * 旧列宽物理行。取值要兼顾合并动画的连续事件与尽快恢复，150ms 在两端之间折衷。
 */
const HISTORY_REFLOW_DEBOUNCE_MS = 150
/**
 * 行数变化达到该幅度时同样值得重排历史。
 *
 * 行数的大幅变化（虚拟键盘收放）会让 tmux 重绘可见区域，把旧列宽的历史物理行
 * 重新带回客户端；±1 行的可视区域抖动（移动端地址栏收放）不触发重排，避免频繁
 * 重置用户的浏览位置。
 */
const TERMINAL_REFLOW_ROWS_THRESHOLD = 2

function countLines(value: string): number {
  if (value.length === 0) return 0
  return value.split('\n').length
}

function boundedAppend(current: string, data: string): string {
  const combined = current + data
  return combined.length <= MAX_RESIDENT_REPLAY_CHARACTERS
    ? combined
    : combined.slice(-MAX_RESIDENT_REPLAY_CHARACTERS)
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
