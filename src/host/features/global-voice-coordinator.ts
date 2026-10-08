import type {
  VoicePcmFrame,
  VoiceRuntimeAdapter,
  VoiceRuntimeCapabilities,
  VoiceRuntimeEvent,
  VoiceRuntimeState,
} from '../../shared/contracts/voice-runtime.js'

export interface GlobalVoiceCoordinatorSnapshot {
  readonly active: boolean
  readonly ownerId: string | null
  readonly state: VoiceRuntimeState
  readonly epoch: number
  readonly capabilities: VoiceRuntimeCapabilities
}

export interface GlobalVoiceCoordinatorOptions {
  readonly adapter: VoiceRuntimeAdapter
  readonly onFinalText?: (text: string, epoch: number) => Promise<void> | void
  readonly onAudio?: (bytes: Uint8Array, epoch: number) => void
  readonly leaseTtlMs?: number
}

/** Host/Profile 级全局语音协调器，不保存任何目标 sessionId。 */
export class GlobalVoiceCoordinator {
  private readonly adapter: VoiceRuntimeAdapter
  private readonly onFinalText: ((text: string, epoch: number) => Promise<void> | void) | undefined
  private readonly onAudio: ((bytes: Uint8Array, epoch: number) => void) | undefined
  private readonly listeners = new Set<(snapshot: GlobalVoiceCoordinatorSnapshot) => void>()
  private readonly eventListeners = new Set<(event: VoiceRuntimeEvent) => void>()
  private readonly runtimeDispose: () => void
  private ownerId: string | null = null
  private state: VoiceRuntimeState = 'disabled'
  private epoch = 0
  private started = false
  private clientEpoch = -1
  private clientSequence = -1
  /** barge-in 后，旧轮次的 final 事件必须在收到新 listening 前丢弃。 */
  private blockedFinalEpoch = -1
  private leaseTimer: ReturnType<typeof setTimeout> | undefined
  private readonly leaseTtlMs: number

  constructor(options: GlobalVoiceCoordinatorOptions) {
    this.adapter = options.adapter
    this.onFinalText = options.onFinalText
    this.onAudio = options.onAudio
    this.leaseTtlMs = Number.isFinite(options.leaseTtlMs) && (options.leaseTtlMs ?? 0) > 0 ? options.leaseTtlMs! : 30_000
    this.runtimeDispose = this.adapter.subscribe((event) => this.handleRuntimeEvent(event))
  }

  snapshot(): GlobalVoiceCoordinatorSnapshot {
    const capabilities = typeof this.adapter.capabilities === 'function' ? this.adapter.capabilities() : this.adapter.capabilities
    return { active: this.started, ownerId: this.ownerId, state: this.state, epoch: this.epoch, capabilities }
  }

  subscribe(listener: (snapshot: GlobalVoiceCoordinatorSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  /** 供二进制语音流把 partial/final/audio 事件回写给持有租约的浏览器。 */
  subscribeRuntimeEvent(listener: (event: VoiceRuntimeEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  async start(ownerId: string): Promise<GlobalVoiceCoordinatorSnapshot> {
    const owner = ownerId.trim()
    if (owner === '') throw new Error('全局语音租约缺少 ownerId')
    if (this.started && this.ownerId !== owner) throw new Error('全局语音助理正在被另一个页面使用')
    if (this.started) return this.snapshot()
    this.ownerId = owner
    this.epoch += 1
    this.clientEpoch = -1
    this.adapter.setEpoch?.(this.epoch)
    this.clientSequence = -1
    this.blockedFinalEpoch = -1
    this.state = 'loading'
    this.emit()
    try {
      await this.adapter.start(owner)
      this.started = true
      this.armLeaseTimer(owner)
      if (this.state === 'loading') this.state = 'standby'
      this.emit()
      return this.snapshot()
    } catch (error) {
      this.started = false
      this.ownerId = null
      this.state = 'error'
      this.emit()
      throw error
    }
  }

  async sendPcm(ownerId: string, frame: VoicePcmFrame): Promise<void> {
    this.ensureOwner(ownerId)
    if (this.adapter.sendPcm === undefined) throw new Error('流式音频运行时不可用')
    await this.adapter.sendPcm(frame, this.epoch)
  }

  async interrupt(ownerId: string): Promise<GlobalVoiceCoordinatorSnapshot> {
    this.ensureOwner(ownerId)
    this.epoch += 1
    this.adapter.setEpoch?.(this.epoch)
    await this.adapter.interrupt()
    this.state = 'interrupted'
    this.blockedFinalEpoch = this.epoch
    this.emit()
    return this.snapshot()
  }

  async stop(ownerId: string): Promise<GlobalVoiceCoordinatorSnapshot> {
    this.ensureOwner(ownerId)
    this.clearLeaseTimer()
    try { await this.adapter.stop() }
    finally {
      // 工作线程异常退出也必须释放租约，允许其他页面重新开始通话。
      this.epoch += 1
      this.started = false
      this.ownerId = null
      this.state = 'disabled'
      this.clientEpoch = -1
      this.clientSequence = -1
      this.blockedFinalEpoch = -1
      this.emit()
    }
    return this.snapshot()
  }

  async speak(ownerId: string, text: string): Promise<void> {
    this.ensureOwner(ownerId)
    if (this.adapter.speak === undefined) throw new Error('语音播报运行时不可用')
    this.state = 'speaking'
    this.emit()
    await this.adapter.speak(text, this.epoch)
  }

  /** 供语音动作桥校验来源页面；不能只保护 start/stop。 */
  assertOwner(ownerId: string): void { this.ensureOwner(ownerId) }

  heartbeat(ownerId: string): GlobalVoiceCoordinatorSnapshot {
    this.ensureOwner(ownerId)
    this.armLeaseTimer(ownerId)
    return this.snapshot()
  }

  /** 接收 Client 的状态事件；原始 PCM 不经过此边界。 */
  acceptClientEvent(ownerId: string, event: VoiceRuntimeEvent, sequence?: number): GlobalVoiceCoordinatorSnapshot {
    // Client 的事件通过独立 RPC 异步投递。停止租约后，已经排队的最后一条
    // 状态事件仍可能晚于 voice/stop 到达；这类事件不再属于任何活动会话，直接
    // 丢弃即可，不能把正常的清理竞态记录成 Host RPC 异常。
    if (!this.started || this.ownerId !== ownerId) return this.snapshot()
    if (sequence !== undefined && sequence < this.clientSequence) return this.snapshot()
    if (sequence !== undefined) this.clientSequence = sequence
    if (event.epoch < this.clientEpoch) return this.snapshot()
    this.clientEpoch = event.epoch
    this.epoch = Math.max(this.epoch, event.epoch)
    if (event.type === 'state') {
      this.state = event.state
      if (event.state === 'listening' && event.epoch >= this.blockedFinalEpoch) this.blockedFinalEpoch = -1
    }
    else if (event.type === 'wake') {
      this.state = 'listening'
      this.blockedFinalEpoch = -1
    }
    else if (event.type === 'barge-in') {
      this.state = 'interrupted'
      this.blockedFinalEpoch = Math.max(this.blockedFinalEpoch, event.epoch)
    } else if (event.type === 'error') this.state = 'error'
    this.emit()
    return this.snapshot()
  }

  dispose(): void {
    this.clearLeaseTimer()
    if (this.started) void Promise.resolve().then(() => this.adapter.stop()).catch(() => undefined)
    this.runtimeDispose()
    this.listeners.clear()
    this.eventListeners.clear()
    this.ownerId = null
    this.started = false
    this.state = 'disabled'
  }

  private handleRuntimeEvent(event: VoiceRuntimeEvent): void {
    if (event.epoch < this.epoch) return
    this.epoch = event.epoch
    if (event.type === 'state') {
      this.state = event.state
      if (event.state === 'listening' && event.epoch >= this.blockedFinalEpoch) this.blockedFinalEpoch = -1
    }
    else if (event.type === 'wake') this.state = 'listening'
    else if (event.type === 'barge-in') {
      this.state = 'interrupted'
      this.blockedFinalEpoch = Math.max(this.blockedFinalEpoch, event.epoch)
    }
    else if (event.type === 'error') this.state = 'error'
    else if (event.type === 'audio') this.onAudio?.(event.bytes, event.epoch)
    this.emit()
    for (const listener of [...this.eventListeners]) {
      try { listener(event) } catch { /* 连接关闭不应破坏运行时 */ }
    }
    if (event.type === 'final' && event.epoch > this.blockedFinalEpoch && event.text.trim() !== '') {
      void this.onFinalText?.(event.text.trim(), event.epoch)
    }
  }

  private ensureOwner(ownerId: string): void {
    if (!this.started || this.ownerId !== ownerId) throw new Error('当前页面没有全局语音租约')
  }

  private armLeaseTimer(ownerId: string): void {
    this.clearLeaseTimer()
    this.leaseTimer = setTimeout(() => {
      if (!this.started || this.ownerId !== ownerId) return
      void this.stop(ownerId).catch(() => undefined)
    }, this.leaseTtlMs)
    const timer = this.leaseTimer as ReturnType<typeof setTimeout> & { unref?: () => void }
    timer.unref?.()
  }

  private clearLeaseTimer(): void {
    if (this.leaseTimer !== undefined) clearTimeout(this.leaseTimer)
    this.leaseTimer = undefined
  }

  private emit(): void {
    const snapshot = this.snapshot()
    for (const listener of [...this.listeners]) {
      try { listener(snapshot) } catch { /* 单个订阅者异常不能破坏全局状态 */ }
    }
  }
}
