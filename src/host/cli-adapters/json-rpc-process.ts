import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'

/** JSON-RPC 消息的最小形状。不同 Agent 的扩展字段保持在 unknown 中。 */
export interface JsonRpcMessage {
  readonly jsonrpc?: string
  readonly id?: number | string | null
  readonly method?: string
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly code?: number; readonly message?: string; readonly data?: unknown }
  readonly [key: string]: unknown
}

export interface JsonRpcProcessOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly spawn?: typeof spawn
}

export interface JsonRpcRequestOptions {
  readonly signal?: AbortSignal | undefined
  readonly onNotification?: (message: JsonRpcMessage) => void
  /** 取消本次请求时是否同时终止整个 Agent 进程；长期会话应关闭此项。 */
  readonly killOnAbort?: boolean
}

/**
 * 统一管理 stdio JSON-RPC 子进程：请求编号、逐行解码、取消和退出清理都在这里完成。
 * 凭据不会被记录，也不会进入错误文本。
 */
export class JsonRpcProcess {
  private readonly options: JsonRpcProcessOptions
  private readonly runSpawn: typeof spawn
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private readonly pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private closed = false
  private lineLoop: Promise<void> | null = null
  private exitPromise: Promise<void> = Promise.resolve()
  private readonly notificationHandlers = new Set<(message: JsonRpcMessage) => void>()
  private serverRequestHandler: ((message: JsonRpcMessage) => unknown | Promise<unknown>) | undefined

  constructor(options: JsonRpcProcessOptions) {
    this.options = options
    this.runSpawn = options.spawn ?? spawn
  }

  async request(method: string, params: unknown = {}, options: JsonRpcRequestOptions = {}): Promise<unknown> {
    this.ensureStarted()
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    if (options.onNotification !== undefined) this.notificationHandlers.add(options.onNotification)
    const onAbort = (): void => {
      this.cancel(id)
      this.pending.get(id)?.reject(new Error('请求已取消'))
      if (options.killOnAbort !== false) {
        const child = this.child
        if (child !== null) terminateChild(child, 'SIGTERM')
      }
    }
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      // Pi 的模型探测命令是自定义 RPC：请求体使用 `type`，不能包成 JSON-RPC
      // method，否则 Pi 会回报 “Unknown command: undefined”。其余适配器仍走标准 JSON-RPC。
      if (method === 'get_available_models') {
        this.write({ id, type: method, ...(isRecord(params) ? params : {}) })
      } else {
        this.write({ jsonrpc: '2.0', id, method, params })
      }
      const result = await promise
      if (options.signal?.aborted) throw new Error('请求已取消')
      return result
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      if (options.onNotification !== undefined) this.notificationHandlers.delete(options.onNotification)
      this.pending.delete(id)
    }
  }

  /** 发送无需响应的 JSON-RPC 通知，例如 initialized 或 cancel。 */
  notify(method: string, params: unknown = {}): void {
    this.ensureStarted()
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** 注册 Agent 发起的 JSON-RPC 服务端请求处理器，例如 Codex 权限审批。 */
  setServerRequestHandler(handler: ((message: JsonRpcMessage) => unknown | Promise<unknown>) | undefined): void {
    this.serverRequestHandler = handler
  }

  /** 为一段流式请求注册独立监听器，响应先到时也不会提前移除。 */
  addNotificationListener(listener: (message: JsonRpcMessage) => void): () => void {
    this.notificationHandlers.add(listener)
    return () => this.notificationHandlers.delete(listener)
  }

  /** 回复由 Agent 发起的 JSON-RPC server request，保留原始 id。 */
  respond(id: number | string, result: unknown): void {
    if (this.closed) throw new Error('Agent 进程已关闭')
    this.ensureStarted()
    this.write({ jsonrpc: '2.0', id, result })
  }

  /** 回复 JSON-RPC server request 的错误结果。错误文本不回传 Provider 原文。 */
  respondError(id: number | string, code = -32000, message = '请求被拒绝'): void {
    if (this.closed) throw new Error('Agent 进程已关闭')
    this.ensureStarted()
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  cancel(id: number | string): void {
    if (this.closed || this.child === null) return
    try { this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } }) } catch { /* 尽力取消 */ }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) pending.reject(new Error('Agent 进程已退出'))
    this.pending.clear()
    const child = this.child
    this.child = null
    if (child === null) return
    terminateChild(child, 'SIGTERM')
    const forceKill = setTimeout(() => terminateChild(child, 'SIGKILL'), 500)
    forceKill.unref?.()
  }

  /** 销毁并等待子进程退出，避免下一轮恢复与上一轮残留进程交叉。 */
  async disposeAndWait(timeoutMs = 2_000): Promise<void> {
    this.dispose()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([this.exitPromise, new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      })])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private ensureStarted(): void {
    if (this.closed) throw new Error('Agent 进程已关闭')
    if (this.child !== null) return
    const child = this.runSpawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      // CLI 可能是 Node 包装脚本，直接 kill 包装进程不会连带真正的 Node 子进程。
      // POSIX 下单独进程组后才能可靠地一次清理整棵进程树。
      detached: process.platform !== 'win32',
    })
    this.child = child
    this.exitPromise = childExitPromise(child)
    // stderr 必须持续消费，但绝不能把命令参数、环境变量或文件片段回传给 DSH。
    child.stderr.on('data', () => undefined)
    this.lineLoop = this.consumeLines(child).catch((error: unknown) => this.fail(error))
  }

  private async consumeLines(child: ChildProcessWithoutNullStreams): Promise<void> {
    const lines = readline.createInterface({ input: child.stdout })
    try {
      for await (const line of lines) {
        if (!line.trim()) continue
        let value: unknown
        try { value = JSON.parse(line) } catch { continue }
        if (!isRecord(value)) continue
        if (typeof value.method === 'string' && value.id !== undefined && value.id !== null) {
          const handler = this.serverRequestHandler
          if (handler === undefined) {
            this.write({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: '请求不受支持' } })
          } else {
            // 先通知流消费者，再等待上层审批结果；通知内容只包含标准协议字段。
            for (const listener of this.notificationHandlers) listener(value)
            const requestId = value.id
            void Promise.resolve(handler(value)).then(
              (result) => this.write({ jsonrpc: '2.0', id: requestId, result }),
              () => this.write({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: '请求被拒绝' } }),
            )
          }
          continue
        }
        // Pi 的 RPC 线协议沿用 request id，但响应字段是 success/data，而不是
        // JSON-RPC 的 result/error；两种形状都必须收敛到同一个 pending 请求。
        if (value.id !== undefined && value.id !== null && value.type === 'response' && typeof value.success === 'boolean') {
          const pending = this.pending.get(value.id as number | string)
          if (pending === undefined) continue
          if (value.success === false) pending.reject(new Error('JSON-RPC 请求失败'))
          else pending.resolve(value.data)
          continue
        }
        if (value.id !== undefined && value.id !== null && (value.result !== undefined || value.error !== undefined)) {
          const pending = this.pending.get(value.id as number | string)
          if (pending === undefined) continue
          // Provider 错误可能带命令行、路径或凭据片段，只向上层暴露稳定错误，不回传原文。
          if (isRecord(value.error)) pending.reject(new Error('JSON-RPC 请求失败'))
          else pending.resolve(value.result)
          continue
        }
        for (const listener of this.notificationHandlers) listener(value)
      }
    } finally {
      lines.close()
      if (!this.closed && this.child === child) this.fail(new Error('Agent 进程已退出'))
    }
  }

  private write(message: JsonRpcMessage): void {
    const stdin = (this.child as unknown as { stdin?: { write(data: string): void } } | null)?.stdin
    if (stdin === undefined) throw new Error('Agent 进程不支持 stdin')
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  private fail(error: unknown): void {
    const failure = error instanceof Error ? error : new Error('Agent 进程读取失败')
    for (const pending of this.pending.values()) pending.reject(failure)
    this.pending.clear()
  }
}

function isRecord(value: unknown): value is JsonRpcMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function childExitPromise(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    const eventChild = child as unknown as { once?: (event: string, listener: () => void) => unknown }
    if (typeof eventChild.once !== 'function') {
      resolve()
      return
    }
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    eventChild.once('close', settle)
    eventChild.once('error', settle)
  })
}

function terminateChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (process.platform !== 'win32' && typeof pid === 'number' && pid > 0) {
    try { process.kill(-pid, signal) } catch { /* 进程组可能已经退出 */ }
  }
  try { child.kill(signal) } catch { /* 进程可能已经退出 */ }
}
