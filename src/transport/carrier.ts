/** DataChannel 二进制 Carrier。所有上层数据必须是 Uint8Array。 */
import { decodeFrame } from './frame.js'
export const TUNNEL_DATA_CHANNEL_LABEL = 'codingns-tunnel'
export interface CodingNsCarrier {
  readonly state: 'connecting' | 'open' | 'closed'
  send(data: Uint8Array): Promise<void>
  subscribe(listener: (data: Uint8Array) => void): () => void
  close(reason?: string): Promise<void>
}

export interface DataChannelLike {
  readonly label?: string
  readonly readyState: string
  readonly bufferedAmount?: number
  bufferedAmountLowThreshold?: number
  send(data: ArrayBuffer | ArrayBufferView): void
  close(): void
  addEventListener(type: 'message' | 'close' | 'open' | 'bufferedamountlow', listener: (event: Event) => void): void
  removeEventListener(type: 'message' | 'close' | 'open' | 'bufferedamountlow', listener: (event: Event) => void): void
}

export interface DataChannelCarrierOptions {
  highWaterMark?: number
  lowWaterMark?: number
  backpressureTimeoutMs?: number
}

/** Host 侧剥离父仓库 relay-tunnel-wire 的首个 hello，随后只转发 DSH Envelope 二进制。 */
export function createRelayTunnelHostCarrier(base: CodingNsCarrier): CodingNsCarrier {
  let helloSeen = false
  let failed = false
  const listeners = new Set<(data: Uint8Array) => void>()
  const unsubscribe = base.subscribe((data) => {
    if (failed) return
    if (!helloSeen) {
      try {
        const frame = decodeFrame(data)
        if (frame?.type !== 'hello') throw new Error('Relay Tunnel 首帧必须是 hello')
        helloSeen = true
      } catch (error) {
        failed = true
        void base.close(error instanceof Error ? error.message : 'Relay Tunnel hello 无效')
      }
      return
    }
    for (const listener of [...listeners]) listener(data)
  })
  return {
    get state() { return failed ? 'closed' : base.state },
    send(data) {
      if (!helloSeen) return Promise.reject(new Error('Relay Tunnel hello 尚未完成'))
      return base.send(data)
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async close(reason) { unsubscribe(); listeners.clear(); await base.close(reason) },
  }
}

/** 将浏览器或 Node WebRTC DataChannel 包装为带背压的二进制 Carrier。 */
export function createDataChannelCarrier(channel: DataChannelLike, options: DataChannelCarrierOptions = {}): CodingNsCarrier {
  let state: CodingNsCarrier['state'] = channel.readyState === 'open' ? 'open' : 'connecting'
  const listeners = new Set<(data: Uint8Array) => void>()
  const high = options.highWaterMark ?? 1024 * 1024
  const low = options.lowWaterMark ?? 256 * 1024
  const timeoutMs = options.backpressureTimeoutMs ?? 30_000
  let chain = Promise.resolve()
  const onOpen = () => { state = 'open' }
  const onClose = () => { state = 'closed'; listeners.clear() }
  const onMessage = (event: Event) => {
    const value = (event as MessageEvent<unknown>).data
    const bytes = toBytes(value)
    if (!bytes) return
    for (const listener of [...listeners]) listener(bytes)
  }
  channel.addEventListener('open', onOpen); channel.addEventListener('close', onClose); channel.addEventListener('message', onMessage)

  const waitOpen = (): Promise<void> => state === 'open' ? Promise.resolve() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('等待 DataChannel open 超时')) }, timeoutMs)
    const cleanup = () => { clearTimeout(timer); channel.removeEventListener('open', onReady); channel.removeEventListener('close', onFail) }
    const onReady = () => { cleanup(); resolve() }; const onFail = () => { cleanup(); reject(new Error('DataChannel 已关闭')) }
    channel.addEventListener('open', onReady); channel.addEventListener('close', onFail)
  })
  const waitBackpressure = (): Promise<void> => {
    if ((channel.bufferedAmount ?? 0) <= high) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('DataChannel 背压等待超时')) }, timeoutMs)
      const check = () => { if ((channel.bufferedAmount ?? 0) <= low) { cleanup(); resolve() } }
      const cleanup = () => { clearTimeout(timer); channel.removeEventListener('bufferedamountlow', check); channel.removeEventListener('close', fail) }
      const fail = () => { cleanup(); reject(new Error('DataChannel 已关闭')) }
      channel.bufferedAmountLowThreshold = low; channel.addEventListener('bufferedamountlow', check); channel.addEventListener('close', fail); check()
    })
  }
  return {
    get state() { return state },
    send(data) {
      if (!(data instanceof Uint8Array)) return Promise.reject(new TypeError('Carrier 只接受 Uint8Array'))
      chain = chain.then(async () => { await waitOpen(); if (state !== 'open') throw new Error('CodingNS DataChannel 尚未 ready'); await waitBackpressure(); channel.send(data) })
      return chain
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async close() { if (state === 'closed') return; state = 'closed'; channel.close(); channel.removeEventListener('open', onOpen); channel.removeEventListener('close', onClose); channel.removeEventListener('message', onMessage); listeners.clear() },
  }
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  return null
}
