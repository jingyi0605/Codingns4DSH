/**
 * 物理载体的最小抽象。浏览器 WebRTC、Node WebRTC 和测试 Fake Carrier 都必须
 * 实现这一层，Transport 其上不依赖具体运行时。
 */
export interface CodingNsCarrier {
  readonly state: 'connecting' | 'open' | 'closed'
  send(data: string): void
  subscribe(listener: (data: string) => void): () => void
  close(reason?: string): Promise<void>
}

export interface DataChannelLike {
  readonly readyState: string
  send(data: string): void
  close(): void
  addEventListener(type: 'message' | 'close' | 'open', listener: (event: Event) => void): void
  removeEventListener(type: 'message' | 'close' | 'open', listener: (event: Event) => void): void
}

/** 将浏览器 RTCDataChannel 包装为无 DOM 依赖的 Carrier。 */
export function createDataChannelCarrier(channel: DataChannelLike): CodingNsCarrier {
  let state: CodingNsCarrier['state'] = channel.readyState === 'open' ? 'open' : 'connecting'
  const listeners = new Set<(data: string) => void>()
  const onOpen = () => { state = 'open' }
  const onClose = () => {
    state = 'closed'
    listeners.clear()
  }
  const onMessage = (event: Event) => {
    const data = (event as MessageEvent<string>).data
    if (typeof data !== 'string') return
    for (const listener of [...listeners]) listener(data)
  }

  channel.addEventListener('open', onOpen)
  channel.addEventListener('close', onClose)
  channel.addEventListener('message', onMessage)

  return {
    get state() { return state },
    send(data) {
      if (state !== 'open') throw new Error('CodingNS DataChannel 尚未 ready')
      channel.send(data)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async close() {
      if (state === 'closed') return
      channel.close()
      state = 'closed'
      channel.removeEventListener('open', onOpen)
      channel.removeEventListener('close', onClose)
      channel.removeEventListener('message', onMessage)
      listeners.clear()
    },
  }
}

