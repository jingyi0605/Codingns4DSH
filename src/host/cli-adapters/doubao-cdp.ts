import { randomUUID } from 'node:crypto'
import { installDoubaoRuntime } from './doubao-runtime.js'

export interface DoubaoConversation {
  readonly id: string
  readonly section: string
  readonly index: number
  readonly found?: boolean
  readonly busy?: boolean
}

export interface DoubaoBridge {
  readonly fetch: typeof fetch
  create(name: string): Promise<DoubaoConversation>
  history(id: string): Promise<DoubaoConversation>
  stop(id: string, reply: string): Promise<void>
  cancel(): Promise<void>
  close(): Promise<void>
}

/** 仅接受当前配置的回环端口，防止 discovery 将登录态桥接到另一个服务。 */
export function doubaoBackgroundSocket(targets: unknown, port: number): string {
  if (!Array.isArray(targets)) throw new Error('豆包调试目标列表无效')
  const matches = targets.filter((target) => target?.url === 'doubao://doubao-background/' || target?.url === 'chrome://doubao-background/')
  if (matches.length !== 1) throw new Error('未找到唯一的豆包原生后台页；请检查 App 版本，不会改用前台窗口')
  const url = new URL(String(matches[0].webSocketDebuggerUrl))
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== String(port)
    || url.username || url.password || !url.pathname.startsWith('/devtools/page/')) throw new Error('豆包调试地址不属于配置的本机端口')
  return url.href
}

/** CDP 仅负责豆包后台页请求，生命周期限定在单轮调用。 */
export class DoubaoCdp {
  private sequence = 0
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  private constructor(private readonly socket: WebSocket, private readonly timeoutMs: number) {
    socket.addEventListener('message', ({ data }) => {
      let message: any
      try { message = JSON.parse(String(data)) } catch { this.fail(new Error('豆包 CDP 响应不是有效 JSON')); return }
      const request = this.pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error('豆包 CDP 请求失败'))
      else request.resolve(message.result)
    })
    socket.addEventListener('close', () => this.fail(new Error('豆包调试连接已关闭；本轮不会自动重发')))
    socket.addEventListener('error', () => this.fail(new Error('豆包调试连接异常')))
  }

  static async connect(url: string, timeoutMs = 45_000): Promise<DoubaoCdp> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); socket.close(); reject(new Error('连接豆包调试端口超时')) }, Math.min(timeoutMs, 5_000))
      const cleanup = (): void => { clearTimeout(timer); socket.removeEventListener('open', opened); socket.removeEventListener('error', failed) }
      const opened = (): void => { cleanup(); resolve() }
      const failed = (): void => { cleanup(); socket.close(); reject(new Error('无法连接豆包调试端口')) }
      socket.addEventListener('open', opened)
      socket.addEventListener('error', failed)
    })
    return new DoubaoCdp(socket, timeoutMs)
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('豆包调试连接不可用'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('豆包后台请求超时；本轮不会自动重发'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket.send(JSON.stringify({ id, method, params })) } catch {
        clearTimeout(timer); this.pending.delete(id); reject(new Error('豆包调试请求发送失败'))
      }
    })
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false })
    if (result.exceptionDetails) {
      // 不暴露 App 异常栈、签名 URL 或请求参数，只提取自有错误码。
      const code = String(result.exceptionDetails.exception?.description ?? '').match(/DOUBAO_[A-Z_0-9]+/u)?.[0]
      throw new Error(`豆包后台接口不可用${code ? `（${code}）` : '，请检查登录状态和网络'}`)
    }
    return result.result?.value as T
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
  }

  close(): void { this.fail(new Error('豆包调试连接已释放')); this.socket.close() }
}

export class DoubaoCdpBridge implements DoubaoBridge {
  private readonly key = `__codingns_doubao_${randomUUID().replaceAll('-', '')}`
  private closed = false
  private constructor(private readonly cdp: DoubaoCdp) {}

  static async open(socket: string): Promise<DoubaoCdpBridge> {
    const bridge = new DoubaoCdpBridge(await DoubaoCdp.connect(socket))
    try {
      await bridge.cdp.evaluate(`(${installDoubaoRuntime.toString()})(${JSON.stringify(bridge.key)})`)
      return bridge
    } catch (error) { await bridge.close(); throw error }
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    return this.cdp.evaluate<T>(`globalThis[${JSON.stringify(this.key)}].${method}(...${JSON.stringify(args)})`)
  }

  create(name: string): Promise<DoubaoConversation> { return this.call('create', name) }
  history(id: string): Promise<DoubaoConversation> { return this.call('history', id) }
  stop(id: string, reply: string): Promise<void> { return this.call('stop', id, reply) }
  async cancel(): Promise<void> { if (!this.closed) await this.call('cancel') }

  readonly fetch: typeof fetch = async (input, init = {}) => {
    if (String(input) !== 'https://www.doubao.com/chat/completion' || init.method !== 'POST' || typeof init.body !== 'string') {
      throw new Error('豆包后台桥只接受对话请求')
    }
    const response = await this.call<{ status: number; mime: string }>('start', JSON.parse(init.body))
    if (response.status !== 200 || !response.mime.includes('text/event-stream')) {
      await this.cancel()
      throw new Error(`豆包未返回对话流（HTTP ${response.status}）；请检查登录状态和模式权限`)
    }
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const chunk = await this.call<number[] | null>('read')
          if (chunk === null) controller.close()
          else controller.enqueue(Uint8Array.from(chunk))
        } catch (error) { controller.error(error) }
      },
      cancel: () => this.cancel(),
    }, { highWaterMark: 0 })
    return new Response(body, { status: response.status, headers: { 'content-type': response.mime } })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // 清理请求有独立上限；即使目标已崩溃，也必须及时释放 Host 连接。
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([this.call('dispose'), new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_000) })]) }
    catch { /* App 关闭后无需继续清理页面变量。 */ }
    finally { clearTimeout(timer); this.cdp.close() }
  }
}
