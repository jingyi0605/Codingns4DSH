export interface HttpSseClientOptions {
  readonly fetch?: typeof fetch
}

export interface HttpJsonResponse<T = unknown> {
  readonly status: number
  readonly headers: Headers
  readonly data: T | null
  readonly text: string
}

export interface SseEvent {
  readonly event: string | null
  readonly data: string
  readonly id?: string
}

/** 只负责 HTTP JSON 与 SSE framing，不理解任何 Agent 私有事件。 */
export class HttpSseClient {
  private readonly fetchImpl: typeof fetch

  constructor(options: HttpSseClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch
  }

  async json<T = unknown>(url: string, init: RequestInit = {}): Promise<HttpJsonResponse<T>> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    const response = await this.fetchImpl(url, {
      ...init,
      headers,
    })
    const text = await response.text()
    let data: T | null = null
    if (text.trim()) {
      try { data = JSON.parse(text) as T } catch { data = null }
    }
    return { status: response.status, headers: response.headers, data, text }
  }

  async *sse(url: string, init: RequestInit = {}): AsyncIterable<SseEvent> {
    const headers = new Headers(init.headers)
    headers.set('accept', 'text/event-stream')
    const response = await this.fetchImpl(url, {
      ...init,
      headers,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    if (!response.body) return

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventName: string | null = null
    let eventId: string | undefined
    let dataLines: string[] = []
    const flush = (): SseEvent | null => {
      if (dataLines.length === 0 && eventName === null && eventId === undefined) return null
      const event: SseEvent = { event: eventName, data: dataLines.join('\n'), ...(eventId === undefined ? {} : { id: eventId }) }
      eventName = null
      eventId = undefined
      dataLines = []
      return event
    }

    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (line === '') {
            const event = flush()
            if (event !== null) yield event
          } else if (line.startsWith(':')) {
            // SSE 注释通常只是心跳。
          } else {
            const separator = line.indexOf(':')
            const field = separator < 0 ? line : line.slice(0, separator)
            const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '')
            if (field === 'event') eventName = value
            else if (field === 'id') eventId = value
            else if (field === 'data') dataLines.push(value)
          }
          newline = buffer.indexOf('\n')
        }
      }
      buffer += decoder.decode()
      if (buffer.trim()) dataLines.push(buffer)
      const event = flush()
      if (event !== null) yield event
    } finally {
      try { await reader.cancel() } catch { /* 连接可能已经关闭 */ }
    }
  }

}
