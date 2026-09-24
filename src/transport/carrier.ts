/** DataChannel 二进制 Carrier。所有上层数据必须是 Uint8Array。 */
import { decodeFrame } from './frame.js'
import { createDshTransportDebugLogger, type DshTransportDebugLogger } from './debug.js'
export const TUNNEL_DATA_CHANNEL_LABEL = 'codingns-tunnel'
/** DataChannel 单消息保守上限；实际对端协商值可能只有 256 KiB。 */
export const DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES = 64 * 1024
export const DATA_CHANNEL_FRAGMENT_HEADER_BYTES = 20
export const DATA_CHANNEL_MAX_REASSEMBLY_BYTES = 16 * 1024 * 1024
const DATA_CHANNEL_FRAGMENT_MAGIC = new Uint8Array([0x44, 0x53, 0x46, 0x01])
export interface CodingNsCarrier {
  readonly state: 'connecting' | 'open' | 'closed'
  send(data: Uint8Array): Promise<void>
  subscribe(listener: (data: Uint8Array) => void): () => void
  /** 物理 carrier 关闭时通知上层重建 generation；不会携带业务正文。 */
  onClosed?(listener: (reason?: string) => void): () => void
  close(reason?: string): Promise<void>
}

export interface DataChannelLike {
  readonly label?: string
  readonly readyState: string
  binaryType?: string
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
  debug?: DshTransportDebugLogger
  reassemblyTimeoutMs?: number
  maxReassemblyBytes?: number
}

interface FragmentAssembly {
  readonly totalBytes: number
  readonly chunkCount: number
  readonly chunks: Map<number, Uint8Array>
  receivedBytes: number
  timer: ReturnType<typeof setTimeout>
}

/** Host 侧剥离父仓库 relay-tunnel-wire 的首个 hello，随后只转发 DSH Envelope 二进制。 */
export function createRelayTunnelHostCarrier(base: CodingNsCarrier, debug?: DshTransportDebugLogger): CodingNsCarrier {
  const logger = debug ?? createDshTransportDebugLogger({ component: 'relay-carrier' })
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
        logger.log('relay.hello.received', { bytes: data.byteLength, frameType: frame.type })
      } catch (error) {
        failed = true
        logger.log('relay.hello.invalid', { bytes: data.byteLength, error: error instanceof Error ? error.message : String(error) })
        void base.close(error instanceof Error ? error.message : 'Relay Tunnel hello 无效')
      }
      return
    }
    logger.log('carrier.receive', { bytes: data.byteLength })
    for (const listener of [...listeners]) listener(data)
  })
  return {
    get state() { return failed ? 'closed' : base.state },
    send(data) {
      if (!helloSeen) return Promise.reject(new Error('Relay Tunnel hello 尚未完成'))
      logger.log('carrier.send', { bytes: data.byteLength })
      return base.send(data)
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async close(reason) { unsubscribe(); listeners.clear(); await base.close(reason) },
  }
}

/** 将浏览器或 Node WebRTC DataChannel 包装为带背压的二进制 Carrier。 */
export function createDataChannelCarrier(channel: DataChannelLike, options: DataChannelCarrierOptions = {}): CodingNsCarrier {
  const logger = options.debug ?? createDshTransportDebugLogger({ component: 'data-channel' })
  let state: CodingNsCarrier['state'] = channel.readyState === 'open' ? 'open' : 'connecting'
  const listeners = new Set<(data: Uint8Array) => void>()
  const closeListeners = new Set<(reason?: string) => void>()
  const high = options.highWaterMark ?? 1024 * 1024
  const low = options.lowWaterMark ?? 256 * 1024
  const timeoutMs = options.backpressureTimeoutMs ?? 30_000
  const reassemblyTimeoutMs = options.reassemblyTimeoutMs ?? 30_000
  const maxReassemblyBytes = options.maxReassemblyBytes ?? DATA_CHANNEL_MAX_REASSEMBLY_BYTES
  let chain = Promise.resolve()
  let receiveChain = Promise.resolve()
  let nextFragmentId = 0
  const fragments = new Map<number, FragmentAssembly>()
  try { channel.binaryType = 'arraybuffer' } catch { /* 某些 WebRTC 实现不允许修改 binaryType */ }
  const clearFragments = (): void => {
    for (const fragment of fragments.values()) clearTimeout(fragment.timer)
    fragments.clear()
  }
  const onOpen = () => { state = 'open'; logger.log('data-channel.open', { label: channel.label ?? null }) }
  let closeNotified = false
  const notifyClosed = (reason?: string) => {
    if (closeNotified) return
    closeNotified = true
    for (const listener of [...closeListeners]) listener(reason)
    closeListeners.clear()
  }
  const onClose = () => { state = 'closed'; clearFragments(); logger.log('data-channel.close', { label: channel.label ?? null }); notifyClosed('DataChannel closed'); listeners.clear() }
  const processBytes = (bytes: Uint8Array | null, value: unknown): void => {
    if (!bytes) {
      logger.log('carrier.receive.invalid', { dataType: Object.prototype.toString.call(value), valueType: typeof value })
      return
    }
    try {
      const complete = acceptFragment(bytes)
      if (complete === null) return
      logger.log('carrier.receive', { bytes: complete.byteLength, physicalBytes: bytes.byteLength, prefix: bytesToHex(bytes.subarray(0, 8)) })
      for (const listener of [...listeners]) listener(complete)
    } catch (error) {
      logger.log('carrier.fragment.error', { physicalBytes: bytes.byteLength, prefix: bytesToHex(bytes.subarray(0, 8)), error: error instanceof Error ? error.message : String(error) })
      state = 'closed'
      clearFragments()
      listeners.clear()
      channel.close()
    }
  }
  const onMessage = (event: Event) => {
    const value = (event as MessageEvent<unknown>).data
    const result = toBytes(value)
    if (!(result instanceof Promise)) {
      processBytes(result, value)
      return
    }
    receiveChain = receiveChain.then(() => result).then((bytes) => processBytes(bytes, value)).catch((error: unknown) => {
      logger.log('carrier.receive.error', { error: error instanceof Error ? error.message : String(error) })
    })
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
    logger.log('carrier.backpressure.wait', { bufferedAmount: channel.bufferedAmount ?? 0, highWaterMark: high, lowWaterMark: low })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('DataChannel 背压等待超时')) }, timeoutMs)
      const check = () => { if ((channel.bufferedAmount ?? 0) <= low) { cleanup(); resolve() } }
      const cleanup = () => { clearTimeout(timer); channel.removeEventListener('bufferedamountlow', check); channel.removeEventListener('close', fail) }
      const fail = () => { cleanup(); reject(new Error('DataChannel 已关闭')) }
      channel.bufferedAmountLowThreshold = low; channel.addEventListener('bufferedamountlow', check); channel.addEventListener('close', fail); check()
    })
  }
  const sendPhysical = async (data: Uint8Array): Promise<void> => {
    await waitOpen()
    if (state !== 'open') throw new Error('CodingNS DataChannel 尚未 ready')
    await waitBackpressure()
    channel.send(data)
    logger.log('carrier.send', { bytes: data.byteLength, bufferedAmount: channel.bufferedAmount ?? 0 })
  }
  const sendLogical = async (data: Uint8Array): Promise<void> => {
    if (data.byteLength <= DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES) {
      await sendPhysical(data)
      return
    }
    const chunkCount = Math.ceil(data.byteLength / DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES)
    const fragmentId = nextFragmentId = (nextFragmentId + 1) >>> 0
    logger.log('carrier.fragment.send', { fragmentId, chunkCount, totalBytes: data.byteLength, payloadBytes: DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES })
    for (let index = 0; index < chunkCount; index += 1) {
      const start = index * DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES
      const chunk = data.subarray(start, Math.min(data.byteLength, start + DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES))
      await sendPhysical(encodeFragment(fragmentId, index, chunkCount, data.byteLength, chunk))
    }
  }
  const acceptFragment = (data: Uint8Array): Uint8Array | null => {
    if (!isFragment(data)) return data
    const parsed = decodeFragment(data, maxReassemblyBytes)
    let assembly = fragments.get(parsed.fragmentId)
    if (!assembly) {
      const timer = setTimeout(() => fragments.delete(parsed.fragmentId), reassemblyTimeoutMs)
      assembly = { totalBytes: parsed.totalBytes, chunkCount: parsed.chunkCount, chunks: new Map(), receivedBytes: 0, timer }
      fragments.set(parsed.fragmentId, assembly)
      logger.log('carrier.fragment.receive', { fragmentId: parsed.fragmentId, chunkCount: parsed.chunkCount, totalBytes: parsed.totalBytes })
    }
    if (assembly.totalBytes !== parsed.totalBytes || assembly.chunkCount !== parsed.chunkCount) throw new Error('DataChannel 分片元数据不一致')
    if (assembly.chunks.has(parsed.index)) return null
    assembly.chunks.set(parsed.index, parsed.body)
    assembly.receivedBytes += parsed.body.byteLength
    if (assembly.chunks.size !== assembly.chunkCount) return null
    clearTimeout(assembly.timer)
    fragments.delete(parsed.fragmentId)
    const result = new Uint8Array(assembly.totalBytes)
    let offset = 0
    for (let index = 0; index < assembly.chunkCount; index += 1) {
      const chunk = assembly.chunks.get(index)
      if (!chunk) throw new Error('DataChannel 分片缺失')
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    if (offset !== assembly.totalBytes) throw new Error('DataChannel 分片总长度不一致')
    logger.log('carrier.fragment.complete', { fragmentId: parsed.fragmentId, chunks: assembly.chunkCount, totalBytes: result.byteLength })
    return result
  }
  return {
    get state() { return state },
    send(data) {
      if (!(data instanceof Uint8Array)) return Promise.reject(new TypeError('Carrier 只接受 Uint8Array'))
      chain = chain.then(() => sendLogical(data))
      return chain
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    onClosed(listener) { if (closeNotified) { listener('DataChannel closed'); return () => undefined } closeListeners.add(listener); return () => closeListeners.delete(listener) },
    async close(reason) { if (state === 'closed') return; state = 'closed'; clearFragments(); notifyClosed(reason ?? 'DataChannel closed'); channel.close(); channel.removeEventListener('open', onOpen); channel.removeEventListener('close', onClose); channel.removeEventListener('message', onMessage); listeners.clear() },
  }
}

function isFragment(data: Uint8Array): boolean {
  return data.byteLength >= DATA_CHANNEL_FRAGMENT_HEADER_BYTES
    && DATA_CHANNEL_FRAGMENT_MAGIC.every((value, index) => data[index] === value)
}

function encodeFragment(fragmentId: number, index: number, chunkCount: number, totalBytes: number, body: Uint8Array): Uint8Array {
  const result = new Uint8Array(DATA_CHANNEL_FRAGMENT_HEADER_BYTES + body.byteLength)
  result.set(DATA_CHANNEL_FRAGMENT_MAGIC)
  const view = new DataView(result.buffer)
  view.setUint32(4, fragmentId)
  view.setUint32(8, index)
  view.setUint32(12, chunkCount)
  view.setUint32(16, totalBytes)
  result.set(body, DATA_CHANNEL_FRAGMENT_HEADER_BYTES)
  return result
}

function decodeFragment(data: Uint8Array, maxReassemblyBytes: number): { fragmentId: number; index: number; chunkCount: number; totalBytes: number; body: Uint8Array } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const fragmentId = view.getUint32(4)
  const index = view.getUint32(8)
  const chunkCount = view.getUint32(12)
  const totalBytes = view.getUint32(16)
  if (chunkCount === 0 || totalBytes <= DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES || totalBytes > maxReassemblyBytes || index >= chunkCount) throw new Error('DataChannel 分片头无效')
  const expectedCount = Math.ceil(totalBytes / DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES)
  if (chunkCount !== expectedCount) throw new Error('DataChannel 分片数量无效')
  const offset = index * DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES
  const expectedBytes = Math.min(DATA_CHANNEL_FRAGMENT_PAYLOAD_BYTES, totalBytes - offset)
  const body = data.subarray(DATA_CHANNEL_FRAGMENT_HEADER_BYTES)
  if (body.byteLength !== expectedBytes) throw new Error('DataChannel 分片长度无效')
  return { fragmentId, index, chunkCount, totalBytes, body: body.slice() }
}

function toBytes(value: unknown): Uint8Array | Promise<Uint8Array | null> | null {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.arrayBuffer().then((body) => new Uint8Array(body))
  return null
}

function bytesToHex(value: Uint8Array): string {
  return [...value].map((item) => item.toString(16).padStart(2, '0')).join('')
}
