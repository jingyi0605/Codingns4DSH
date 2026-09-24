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
  /** 仅保存在当前 Host 内存中的运行时退出通知，不进入终端持久记录。 */
  readonly onExit?: (exitCode: number | null) => void | Promise<void>
}

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
  private readonly controllers = new Map<string, ControllerBinding>()
  private readonly followers = new Map<string, Set<ActiveFollower>>()
  private readonly operations = new Map<string, Promise<unknown>>()
  private readonly exitCallbacks = new Map<string, (exitCode: number | null) => void | Promise<void>>()
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
    return this.enqueue(identity, async () => {
      const existing = this.store.get(identity)
      if (existing !== undefined) {
        if (existing.state === 'closed' || existing.state === 'closing') {
          throw new TerminalServiceError('TERMINAL_UNAVAILABLE', '终端已关闭，不能复用相同标识')
        }
        const runtime = await this.runtimes.inspect(existing)
        if (runtime.alive) {
          const running = existing.state === 'running'
            ? existing
            : await this.update(existing, { state: 'running', error: '' })
          return this.info(running)
        }
        await this.update(existing, { state: 'lost', error: '持久终端运行时不存在' })
        throw new TerminalServiceError('TERMINAL_RUNTIME_LOST', '持久终端运行时不存在')
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
      try {
        const runtime = await this.runtimes.create(record)
        if (!runtime.alive) throw new Error('backend 创建后未报告存活状态')
        if (input.onExit !== undefined) this.exitCallbacks.set(identityKey(identity), input.onExit)
        const running = await this.update(record, { state: 'running', error: '' })
        if (input.onExit !== undefined) await this.runtimes.monitor(running, (exitCode) => { void this.markExited(identity, exitCode) })
        return this.info(running)
      } catch (error) {
        this.exitCallbacks.delete(identityKey(identity))
        await this.update(record, { state: 'error', error: errorMessage(error) })
        throw error
      }
    })
  }

  /** 返回 Host 侧完整记录，供进程服务读取 runtimeSessionKey 和运行身份。 */
  getRecord(identity: TerminalRecordIdentity): PersistentTerminalRecord | undefined {
    this.requireInitialized()
    return this.store.get(identity)
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
          await this.runtimes.terminate(current)
          await this.runtimes.detachTerminal(current)
          await this.update(current, { state: 'closed', exitCode: null, error: '' })
          return
        }
        try {
          const identity = await this.runtimes.inspect(current)
          await this.update(current, identity.alive
            ? { state: 'running', error: '' }
            : { state: 'lost', error: identity.detail ?? '持久终端运行时不存在' })
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
    const key = identityKey(input.identity)
    const queue = new TerminalFrameQueue(2 * 1024 * 1024)
    const follower: ActiveFollower = { attachmentId: input.attachmentId, generation: input.generation, queue }
    this.addFollower(key, follower)
    // 无论 backend attach 是否同步吐出恢复画面，wire 的第一帧都必须是 snapshot。
    queue.pushSnapshot(this.info(record))
    let attachment
    try {
      attachment = await this.runtimes.attach(record, {
        identity: input.identity,
        generation: input.generation,
        streamId: input.attachmentId,
        requestedAttachmentId: input.attachmentId,
        cols: record.cols,
        rows: record.rows,
        onData: (data) => queue.pushOutput(data),
        onExit: (exitCode) => { void this.handleRuntimeExit(input.identity, exitCode, queue) },
      })
    } catch (error) {
      this.removeFollower(key, follower)
      queue.finish()
      throw error
    }
    this.controllers.set(key, {
      attachmentId: input.attachmentId,
      subscriptionId: attachment.subscriptionId,
      generation: input.generation,
    })
    this.broadcastState(input.identity)
    const abort = (): void => queue.finish()
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) abort()
    try {
      yield* queue.read()
    } finally {
      input.signal.removeEventListener('abort', abort)
      this.removeFollower(key, follower)
      if (this.controllers.get(key)?.subscriptionId === attachment.subscriptionId) {
        this.controllers.delete(key)
        this.broadcastState(input.identity)
      }
      await this.runtimes.detach(attachment.subscriptionId)
    }
  }

  async write(identity: TerminalRecordIdentity, attachmentId: string, data: string): Promise<void> {
    const controller = this.requireController(identity, attachmentId)
    await this.runtimes.write(controller.subscriptionId, data)
  }

  /** Host 内部向持久终端发送一次输入，不改变浏览器 attach 控制权。 */
  async writeInitialInput(identity: TerminalRecordIdentity, data: string): Promise<void> {
    if (data.length === 0) throw new TypeError('终端输入不能为空')
    this.requireInitialized()
    await this.enqueue(identity, async () => {
      const record = this.requireAvailable(identity)
      await this.runtimes.writeSession(record, data)
    })
  }

  async resize(identity: TerminalRecordIdentity, attachmentId: string, cols: number, rows: number): Promise<void> {
    validateSize(cols, rows)
    const controller = this.requireController(identity, attachmentId)
    const record = this.requireAvailable(identity)
    // ResizeObserver 可能重复报告同一尺寸；相同尺寸不应再次向 PTY 发送 SIGWINCH。
    if (record.cols === cols && record.rows === rows) return
    await this.runtimes.resize(controller.subscriptionId, cols, rows)
    await this.update(record, { cols, rows })
    this.broadcastState(identity)
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
    await this.enqueue(identity, async () => {
      const record = this.store.get(identity)
      if (record === undefined || record.state === 'closed') return
      const closing = record.state === 'closing' ? record : await this.update(record, { state: 'closing' })
      this.broadcastState(identity)
      await this.runtimes.terminate(closing)
      await this.runtimes.detachTerminal(identity)
      this.controllers.delete(identityKey(identity))
      this.exitCallbacks.delete(identityKey(identity))
      const closed = await this.update(closing, { state: 'closed', exitCode: null, error: '' })
      this.broadcastState(identity, closed)
      this.finishFollowers(identityKey(identity))
    })
  }

  async detachGeneration(generation: string): Promise<void> {
    await this.runtimes.detachGeneration(generation)
    const changed = new Set<string>()
    for (const [key, binding] of this.controllers) {
      if (binding.generation !== generation) continue
      this.controllers.delete(key)
      changed.add(key)
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
    for (const followers of this.followers.values()) for (const follower of followers) follower.queue.finish()
    this.followers.clear()
    this.controllers.clear()
    this.exitCallbacks.clear()
    await this.runtimes.dispose()
  }

  private requireController(identity: TerminalRecordIdentity, attachmentId: string): ControllerBinding {
    this.requireAvailable(identity)
    const controller = this.controllers.get(identityKey(identity))
    if (controller?.attachmentId !== attachmentId) {
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

  private async handleRuntimeExit(
    identity: TerminalRecordIdentity,
    exitCode: number | null,
    queue: TerminalFrameQueue,
  ): Promise<void> {
    try {
      await this.markExited(identity, exitCode)
    } finally {
      // 先发 exited 元数据，再结束 Remote 流；否则官方 Client 会把正常退出误判为 attach 故障。
      queue.finish()
    }
  }

  private async markExited(identity: TerminalRecordIdentity, exitCode: number | null): Promise<void> {
    await this.enqueue(identity, async () => {
      const record = this.store.get(identity)
      if (record === undefined || record.state !== 'running') return
      const exited = await this.update(record, { state: 'exited', exitCode, error: '' })
      this.broadcastState(identity, exited)
      const callback = this.exitCallbacks.get(identityKey(identity))
      this.exitCallbacks.delete(identityKey(identity))
      await callback?.(exitCode)
    })
  }

  private info(record: PersistentTerminalRecord): CodingNsWebTerminalInfo {
    const controllerId = this.controllers.get(identityKey(record))?.attachmentId
    const state = record.state === 'running' || record.state === 'starting'
      ? 'running'
      : record.state === 'closed' || record.state === 'exited'
        ? 'exited'
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

  private async update(
    record: PersistentTerminalRecord,
    patch: Partial<Pick<PersistentTerminalRecord, 'state' | 'title' | 'cols' | 'rows' | 'exitCode' | 'error'>>,
  ): Promise<PersistentTerminalRecord> {
    const next = await this.store.patch(record, { ...patch, updatedAt: this.now().toISOString() })
    if (next === undefined) throw new Error('终端记录在更新期间消失')
    return next
  }

  private broadcastState(identity: TerminalRecordIdentity, record = this.store.get(identity)): void {
    if (record === undefined) return
    const info = this.info(record)
    for (const follower of this.followers.get(identityKey(identity)) ?? []) follower.queue.pushState(info)
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

  pushSnapshot(info: CodingNsWebTerminalInfo): void {
    this.push({ type: 'snapshot', sequence: this.sequence, screen: '', info })
  }

  pushOutput(data: string): void {
    this.sequence += 1
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

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
