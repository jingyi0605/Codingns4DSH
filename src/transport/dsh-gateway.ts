import type { CodingNsCarrier } from './carrier.js'
import {
  type DshChannel,
  type DshEnvelope,
  type DshHostScope,
} from './dsh-envelope.js'
import { DshSession, type DshSessionOptions } from './dsh-session.js'
import { createDshTransportDebugLogger, type DshTransportDebugLogger } from './debug.js'

export const DSH_GATEWAY_PATH = '/__dsh__/transport/v1'

export interface DshStreamContext {
  readonly envelope: DshEnvelope
  readonly session: DshSession
  send(type: string, meta?: Record<string, unknown>, body?: Uint8Array): void
  close(): void
}

export interface DshGatewayFeature {
  readonly channel?: DshChannel
  readonly operation?: string
  canHandle?(envelope: DshEnvelope): boolean | Promise<boolean>
  handleStream?(context: DshStreamContext): void | Promise<void> | AsyncIterable<DshEnvelope>
  handleMessage?(context: DshStreamContext, envelope: DshEnvelope): void | Promise<void>
  handleWindow?(context: DshStreamContext, envelope: DshEnvelope): void | Promise<void>
}

export interface DshGatewayOptions {
  carrier: CodingNsCarrier
  session?: DshSession
  sessionOptions?: Omit<DshSessionOptions, 'carrier'>
  /** 只依赖 FeatureRegistry 的 modules()，避免把具体 Host services 类型泄漏到传输层。 */
  registry?: { modules(): readonly unknown[] }
  features?: readonly DshGatewayFeature[]
  hostScope: DshHostScope
  generation: string
  /** 当前 DSH 宿主版本；用于没有显式 session 的默认 Gateway。 */
  dshVersion?: string
  maxStreams?: number
  debug?: DshTransportDebugLogger
}

/** 将 DSH Session 后的 Envelope 按 streamId 路由到 FeatureRegistry 模块。 */
export class DshGateway {
  readonly session: DshSession
  private readonly streams = new Map<string, { envelope: DshEnvelope; feature: DshGatewayFeature; context: DshStreamContext }>()
  /**
   * stream.open 的 feature 选择和本地资源创建可能异步完成。
   * 取消帧可以在这段窗口内到达，必须先登记 opening，不能让取消穿透后又把旧流插入 streams。
   */
  private readonly opening = new Set<string>()
  private readonly cancelledOpening = new Set<string>()
  private readonly maxStreams: number
  private readonly features: readonly DshGatewayFeature[]
  private sequence = 0
  private started = false
  private unsubscribe: (() => void) | undefined
  private readonly debug: DshTransportDebugLogger

  constructor(private readonly options: DshGatewayOptions) {
    this.maxStreams = options.maxStreams ?? 128
    this.debug = options.debug ?? createDshTransportDebugLogger({ component: 'gateway' })
    this.features = options.features ?? []
    this.session = options.session ?? new DshSession({
      carrier: options.carrier,
      role: 'host',
      generation: options.generation,
      hostScope: options.hostScope,
      acceptInitialGeneration: true,
      ...(options.dshVersion === undefined ? {} : { dshVersion: options.dshVersion }),
      ...(options.sessionOptions ?? {}),
      debug: this.debug,
    })
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.debug.log('gateway.start', { generation: this.session.generation, hostId: this.options.hostScope.hostId })
    this.unsubscribe = this.session.subscribe((envelope) => { void this.route(envelope) })
    this.session.start()
  }

  async close(reason = 'DSH Gateway 已关闭'): Promise<void> {
    if (!this.started) return
    this.started = false
    this.debug.log('gateway.close', { reason, streams: this.streams.size })
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const active of this.streams.values()) {
      try {
        await active.feature.handleMessage?.(active.context, { ...active.envelope, type: 'stream.cancel', meta: { reason } })
      } catch {
        // 关闭阶段不再向远端传播业务错误，但必须继续清理其他流。
      }
    }
    this.streams.clear()
    this.opening.clear()
    this.cancelledOpening.clear()
    this.session.close(reason)
  }

  get path(): string { return DSH_GATEWAY_PATH }

  private async route(envelope: DshEnvelope): Promise<void> {
    this.debug.log('gateway.receive', envelopeDebugFields(envelope))
    if (envelope.generation !== this.session.generation
      || envelope.hostScope.hostId !== this.options.hostScope.hostId
      || envelope.hostScope.kind !== this.options.hostScope.kind) {
      this.debug.log('gateway.scope.drop', { expectedGeneration: this.session.generation, expectedHostId: this.options.hostScope.hostId, expectedHostKind: this.options.hostScope.kind, ...envelopeDebugFields(envelope) })
      this.sendError(envelope, 'RESOURCE_SCOPE_STALE', '资源属于已经失效的 HostScope')
      return
    }
    if (envelope.type === 'stream.open') {
      await this.openStream(envelope)
      return
    }
    if (envelope.type === 'stream.cancel' || envelope.type === 'stream.close') {
      const active = this.streams.get(envelope.streamId)
      if (active) {
        try {
          await active.feature.handleMessage?.(active.context, envelope)
        } catch (error) {
          this.sendError(envelope, 'STREAM_FAILED', error instanceof Error ? error.message : 'DSH 流清理失败')
        } finally {
          // Feature 清理失败也不能让已取消的流继续占用会话配额。
          this.streams.delete(envelope.streamId)
        }
      } else if (this.opening.has(envelope.streamId)) {
        // openStream 尚未完成时不能调用尚不存在的 context；记录取消，
        // 由 openStream 在完成异步准备后丢弃资源并发送最终 close。
        this.cancelledOpening.add(envelope.streamId)
      }
      this.send({ ...envelope, type: 'stream.close', sequence: this.nextSequence(), meta: {} })
      return
    }
    const active = this.streams.get(envelope.streamId)
    if (active === undefined) {
      this.sendError(envelope, 'STREAM_LOST', '流不存在或已经关闭')
      return
    }
    if (envelope.type === 'stream.window') {
      await active.feature.handleWindow?.(active.context, envelope)
      return
    }
    await active.feature.handleMessage?.(active.context, envelope)
  }

  private async openStream(envelope: DshEnvelope): Promise<void> {
    if (this.streams.has(envelope.streamId)) {
      this.sendError(envelope, 'MESSAGE_INVALID', 'streamId 已经使用')
      return
    }
    if (this.streams.size + this.opening.size >= this.maxStreams) {
      this.debug.log('gateway.flow-control.rejected', {
        activeStreams: this.streams.size,
        openingStreams: this.opening.size,
        maxStreams: this.maxStreams,
        ...envelopeDebugFields(envelope),
      })
      this.sendError(envelope, 'FLOW_CONTROL_INVALID', '超过会话流数量上限')
      return
    }
    this.opening.add(envelope.streamId)
    let streamHandlerStarted = false
    try {
      const feature = await this.findFeature(envelope)
      if (!feature) {
        this.debug.log('gateway.feature.missing', envelopeDebugFields(envelope))
        this.sendError(envelope, 'FEATURE_DISABLED', '没有启用匹配的 DSH 功能模块')
        return
      }
      if (this.cancelledOpening.delete(envelope.streamId)) {
        // 取消发生在 feature 选择期间，不能再启动本地 WebSocket 或其它子资源。
        this.send({ ...envelope, type: 'stream.close', sequence: this.nextSequence(), meta: {} })
        return
      }
    let context!: DshStreamContext
    context = {
      envelope,
      session: this.session,
      send: (type, meta = {}, body) => {
        const message: DshEnvelope = {
          ...envelope,
          messageId: `${envelope.streamId}_${this.nextSequence()}`,
          type,
          sequence: this.nextSequence(),
          meta,
          ...(body === undefined ? {} : { body }),
        }
        this.send(message)
      },
      close: () => {
        this.streams.delete(envelope.streamId)
        this.send({ ...envelope, type: 'stream.close', sequence: this.nextSequence(), meta: {} })
      },
    }
    this.streams.set(envelope.streamId, { envelope, feature, context })
    // 进入 streams 后已经完成异步初始化，不能再同时计入 opening。
    // 否则一个正在处理的流会被计算两次，实际并发达到上限一半就会误报流控错误。
    this.opening.delete(envelope.streamId)
    this.debug.log('gateway.stream.accepted', { ...envelopeDebugFields(envelope), feature: feature.operation ?? feature.channel ?? 'custom' })
      this.send({ ...envelope, type: 'stream.accepted', sequence: this.nextSequence(), meta: { channel: envelope.channel } })
      if (!feature.handleStream) return
      streamHandlerStarted = true
      const result = await feature.handleStream(context)
      if (result && Symbol.asyncIterator in Object(result)) {
        for await (const message of result as AsyncIterable<DshEnvelope>) this.send(message)
      }
    } catch (error) {
      this.debug.log('gateway.stream.error', { ...envelopeDebugFields(envelope), error: error instanceof Error ? error.message : String(error) })
      if (this.streams.has(envelope.streamId)) {
        this.sendError(envelope, 'STREAM_FAILED', error instanceof Error ? error.message : 'DSH 流处理失败')
        this.streams.delete(envelope.streamId)
      }
    } finally {
      this.opening.delete(envelope.streamId)
      this.cancelledOpening.delete(envelope.streamId)
      if (streamHandlerStarted && this.streams.delete(envelope.streamId)) {
        // handleStream 正常返回但遗漏 context.close 时，网关仍必须收敛流状态。
        try {
          this.send({ ...envelope, type: 'stream.close', sequence: this.nextSequence(), meta: {} })
        } catch {
          // 物理连接已关闭时，释放本地流状态优先于发送结束帧。
        }
      }
    }
  }

  private async findFeature(envelope: DshEnvelope): Promise<DshGatewayFeature | undefined> {
    for (const feature of this.features) {
      if (feature.channel && feature.channel !== envelope.channel) continue
      if (feature.operation && feature.operation !== envelope.meta.operation) continue
      if (!feature.canHandle || await feature.canHandle(envelope)) return feature
    }
    if (!this.options.registry) return undefined
    for (const module of this.options.registry.modules()) {
      const candidate = module as unknown as DshGatewayFeature
      if (!candidate.canHandle && !candidate.handleStream && !candidate.handleMessage && !candidate.handleWindow) continue
      if (candidate.channel && candidate.channel !== envelope.channel) continue
      if (candidate.operation && candidate.operation !== envelope.meta.operation) continue
      if (!candidate.canHandle || await candidate.canHandle(envelope)) return candidate
    }
    return undefined
  }

  private sendError(envelope: DshEnvelope, code: string, detail: string): void {
    this.debug.log('gateway.error', { code, detail, ...envelopeDebugFields(envelope) })
    this.send({
      ...envelope,
      messageId: `${envelope.messageId}_error`,
      type: 'stream.error',
      sequence: this.nextSequence(),
      meta: { errorCode: code, detail, retryable: false },
    })
  }

  private send(envelope: DshEnvelope): void {
    this.session.send(envelope)
  }

  private nextSequence(): number {
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('DSH Gateway sequence 已耗尽')
    return ++this.sequence
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
