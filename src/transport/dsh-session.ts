import type { CodingNsCarrier } from './carrier.js'
import {
  DSH_ENVELOPE_PROTOCOL,
  decodeDshEnvelope,
  encodeDshEnvelope,
  type DshEnvelope,
  type DshHostScope,
} from './dsh-envelope.js'
import { DSH_VERSION } from '../shared/contracts/version.js'
import { createDshTransportDebugLogger, type DshTransportDebugLogger } from './debug.js'

export type DshSessionRole = 'client' | 'host'
export type DshSessionState = 'idle' | 'handshaking' | 'ready' | 'degraded' | 'closed'

export interface DshSessionOptions {
  carrier: CodingNsCarrier
  role: DshSessionRole
  generation: string
  hostScope: DshHostScope
  dshVersion?: string
  capabilities?: readonly string[]
  protocol?: string
  heartbeatMs?: number
  onReady?(session: DshSession): void
  onEnvelope?(envelope: DshEnvelope): void
  onError?(error: Error): void
  debug?: DshTransportDebugLogger
}

/** 负责 DSH hello/ready、版本能力协商和心跳，不执行任何业务。 */
export class DshSession {
  private stateValue: DshSessionState = 'idle'
  private readonly listeners = new Set<(envelope: DshEnvelope) => void>()
  private readonly unsubscribe: () => void
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private messageCounter = 0
  private remoteCapabilities: readonly string[] = []
  private readyValue: Promise<void> | undefined
  private readyResolve: (() => void) | undefined
  private readyReject: ((error: Error) => void) | undefined
  private readonly debug: DshTransportDebugLogger

  constructor(private readonly options: DshSessionOptions) {
    this.debug = options.debug ?? createDshTransportDebugLogger({ component: `session-${options.role}` })
    this.unsubscribe = options.carrier.subscribe((data) => this.receive(data as Uint8Array))
    if (options.onEnvelope) this.listeners.add(options.onEnvelope)
  }

  get state(): DshSessionState { return this.stateValue }
  get ready(): boolean { return this.stateValue === 'ready' }
  get capabilities(): readonly string[] { return this.remoteCapabilities }

  start(): void {
    if (this.stateValue !== 'idle') return
    this.stateValue = 'handshaking'
    this.debug.log('session.start', { role: this.options.role, generation: this.options.generation, hostId: this.options.hostScope.hostId, hostKind: this.options.hostScope.kind })
    this.readyValue = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // Host 侧通常只监听 onReady，不会调用 waitReady；即使远端作用域
    // 无效，也不能让 ready Promise 变成 Node 的未处理拒绝。
    void this.readyValue.catch(() => undefined)
    if (this.options.role === 'client') this.sendHello()
    this.startHeartbeat()
  }

  waitReady(signal?: AbortSignal): Promise<void> {
    if (this.ready) return Promise.resolve()
    if (this.stateValue === 'closed') return Promise.reject(new Error('DSH Session 已关闭'))
    if (!this.readyValue) this.start()
    const promise = this.readyValue as Promise<void>
    if (!signal) return promise
    if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('会话等待已取消'))
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : new Error('会话等待已取消')), { once: true })),
    ])
  }

  subscribe(listener: (envelope: DshEnvelope) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(envelope: DshEnvelope): void {
    if (this.stateValue === 'closed') throw new Error('DSH Session 已关闭')
    const pending = this.options.carrier.send(encodeDshEnvelope(envelope))
    this.debug.log('session.send', envelopeDebugFields(envelope))
    if (pending && typeof pending.catch === 'function') {
      void pending.catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))))
    }
  }

  close(reason = 'DSH Session 已关闭'): void {
    if (this.stateValue === 'closed') return
    this.stateValue = 'closed'
    this.debug.log('session.close', { reason })
    this.unsubscribe()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    this.readyReject?.(new Error(reason))
    this.readyReject = undefined
    this.readyResolve = undefined
  }

  private sendHello(): void {
    this.send(this.createEnvelope('session.hello', 'session', {
      protocol: this.options.protocol ?? DSH_ENVELOPE_PROTOCOL,
      dshVersion: this.options.dshVersion ?? DSH_VERSION,
      capabilities: [...this.options.capabilities ?? []],
    }))
  }

  private sendReady(capabilities: readonly string[]): void {
    this.send(this.createEnvelope('session.ready', 'session', {
      protocol: this.options.protocol ?? DSH_ENVELOPE_PROTOCOL,
      dshVersion: this.options.dshVersion ?? DSH_VERSION,
      capabilities: [...capabilities],
      byteCredit: 64 * 1024,
      messageCredit: 32,
    }))
  }

  private receive(data: Uint8Array): void {
    if (this.stateValue === 'closed') return
    let envelope: DshEnvelope
    try {
      envelope = decodeDshEnvelope(data)
      this.validateScope(envelope)
    } catch (error) {
      this.debug.log('session.receive.invalid', { bytes: data.byteLength, error: error instanceof Error ? error.message : String(error) })
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.debug.log('session.receive', { bytes: data.byteLength, ...envelopeDebugFields(envelope) })
    if (envelope.channel === 'session') {
      this.receiveSession(envelope)
      return
    }
    if (!this.ready) {
      this.fail(new Error('SESSION_NOT_READY'))
      return
    }
    for (const listener of [...this.listeners]) listener(envelope)
  }

  private receiveSession(envelope: DshEnvelope): void {
    if (envelope.type === 'session.hello') {
      if (this.options.role !== 'host' || envelope.sequence !== 0 || this.stateValue === 'ready') {
        this.fail(new Error('非法 session.hello'))
        return
      }
      const protocol = envelope.meta.protocol
      const dshVersion = envelope.meta.dshVersion
      if (protocol !== (this.options.protocol ?? DSH_ENVELOPE_PROTOCOL) || dshVersion !== (this.options.dshVersion ?? DSH_VERSION)) {
        this.fail(new Error('PROTOCOL_VERSION_UNSUPPORTED'))
        return
      }
      const offered = readCapabilities(envelope.meta.capabilities)
      const allowed = new Set(this.options.capabilities ?? offered)
      this.remoteCapabilities = offered.filter((capability) => allowed.has(capability))
      this.stateValue = 'ready'
      this.debug.log('session.ready', { role: this.options.role, capabilities: this.remoteCapabilities })
      this.sendReady(this.remoteCapabilities)
      this.readyResolve?.()
      this.options.onReady?.(this)
      return
    }
    if (envelope.type === 'session.ready') {
      if (this.options.role !== 'client' || this.stateValue !== 'handshaking') {
        this.fail(new Error('非法 session.ready'))
        return
      }
      const protocol = envelope.meta.protocol
      const dshVersion = envelope.meta.dshVersion
      if (protocol !== (this.options.protocol ?? DSH_ENVELOPE_PROTOCOL) || dshVersion !== (this.options.dshVersion ?? DSH_VERSION)) {
        this.fail(new Error('PROTOCOL_VERSION_UNSUPPORTED'))
        return
      }
      this.remoteCapabilities = readCapabilities(envelope.meta.capabilities)
      this.stateValue = 'ready'
      this.debug.log('session.ready', { role: this.options.role, capabilities: this.remoteCapabilities })
      this.readyResolve?.()
      this.options.onReady?.(this)
      return
    }
    if (envelope.type === 'session.ping') {
      this.send(this.createEnvelope('session.pong', 'session', { timestamp: Date.now() }))
      return
    }
    if (envelope.type === 'session.pong') return
    if (envelope.type === 'session.close') {
      this.close(typeof envelope.meta.reason === 'string' ? envelope.meta.reason : '远端关闭 DSH Session')
      return
    }
    this.fail(new Error('MESSAGE_INVALID'))
  }

  private validateScope(envelope: DshEnvelope): void {
    if (envelope.generation !== this.options.generation
      || envelope.hostScope.hostId !== this.options.hostScope.hostId
      || envelope.hostScope.kind !== this.options.hostScope.kind) {
      throw new Error('RESOURCE_SCOPE_STALE')
    }
  }

  private createEnvelope(type: string, channel: DshEnvelope['channel'], meta: Record<string, unknown>): DshEnvelope {
    return {
      version: 1,
      messageId: `${this.options.role[0]}_${++this.messageCounter}`,
      streamId: 'session',
      channel,
      type,
      sequence: this.messageCounter - 1,
      generation: this.options.generation,
      hostScope: this.options.hostScope,
      meta,
    }
  }

  private startHeartbeat(): void {
    const interval = this.options.heartbeatMs ?? 30_000
    if (!Number.isFinite(interval) || interval <= 0) return
    this.heartbeat = setInterval(() => {
      if (this.stateValue === 'closed') return
      try { this.send(this.createEnvelope('session.ping', 'session', { timestamp: Date.now() })) } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))) }
    }, interval)
  }

  private fail(error: Error): void {
    this.stateValue = 'degraded'
    this.debug.log('session.error', { error: error.message })
    this.readyReject?.(error)
    this.options.onError?.(error)
  }
}

function envelopeDebugFields(envelope: DshEnvelope): Record<string, unknown> {
  return {
    type: envelope.type,
    channel: envelope.channel,
    streamId: envelope.streamId,
    sequence: envelope.sequence,
    generation: envelope.generation,
    hostId: envelope.hostScope.hostId,
    hostKind: envelope.hostScope.kind,
    operation: typeof envelope.meta.operation === 'string' ? envelope.meta.operation : undefined,
    bodyBytes: envelope.body?.byteLength ?? 0,
  }
}

function readCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('MESSAGE_INVALID')
  return [...new Set(value)]
}
