export const CONPTY_BROKER_PROTOCOL_VERSION = 1 as const
export const CONPTY_BROKER_MAX_BUFFERED_BYTES = 1024 * 1024

export type ConptyBrokerRequest =
  | { readonly version: 1; readonly auth: string; readonly type: 'inspect' }
  | { readonly version: 1; readonly auth: string; readonly type: 'attach'; readonly cols: number; readonly rows: number }
  | { readonly version: 1; readonly auth: string; readonly type: 'input'; readonly data: string }
  | { readonly version: 1; readonly auth: string; readonly type: 'resize'; readonly cols: number; readonly rows: number }
  | { readonly version: 1; readonly auth: string; readonly type: 'detach' }
  | { readonly version: 1; readonly auth: string; readonly type: 'terminate' }

export type ConptyBrokerMessage =
  | { readonly version: 1; readonly type: 'inspect-result'; readonly alive: boolean; readonly brokerPid: number; readonly shellPid: number }
  | { readonly version: 1; readonly type: 'attached'; readonly brokerPid: number; readonly shellPid: number }
  | { readonly version: 1; readonly type: 'output'; readonly data: string }
  | { readonly version: 1; readonly type: 'exit'; readonly exitCode: number | null }
  | { readonly version: 1; readonly type: 'terminated' }
  | { readonly version: 1; readonly type: 'error'; readonly code: string; readonly message: string }

export interface JsonLineTarget {
  write(data: string): unknown
}

/** broker 同时只允许一个 attach；重复连接不能抢占当前终端。 */
export class ExclusiveAttachmentLease<T extends object> {
  private owner: T | null = null

  acquire(candidate: T): boolean {
    if (this.owner !== null && this.owner !== candidate) return false
    this.owner = candidate
    return true
  }

  /** 新 attach 接管输入控制权；旧 attach 保持只读输出。 */
  takeover(candidate: T): T | null {
    const previous = this.owner
    this.owner = candidate
    return previous
  }

  release(candidate: T): void {
    if (this.owner === candidate) this.owner = null
  }

  owns(candidate: T): boolean {
    return this.owner === candidate
  }

  get current(): T | null {
    return this.owner
  }
}

/** 每条消息一个 JSON 行，避免终端输出与控制帧混在同一字节流中。 */
export function writeBrokerMessage(target: JsonLineTarget, message: ConptyBrokerMessage | ConptyBrokerRequest): void {
  target.write(`${JSON.stringify(message)}\n`)
}

export function createJsonLineParser(onValue: (value: unknown) => void): { push(chunk: string | Uint8Array): void } {
  const decoder = new TextDecoder()
  let pending = ''
  return {
    push(chunk) {
      pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      let boundary = pending.indexOf('\n')
      while (boundary >= 0) {
        const line = pending.slice(0, boundary).trim()
        pending = pending.slice(boundary + 1)
        if (line !== '') onValue(JSON.parse(line))
        boundary = pending.indexOf('\n')
      }
      if (pending.length > 2 * 1024 * 1024) throw new Error('broker 控制帧超过限制')
    },
  }
}

export function parseBrokerRequest(value: unknown): ConptyBrokerRequest | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.auth !== 'string' || typeof value.type !== 'string') return null
  if (value.type === 'inspect' || value.type === 'detach' || value.type === 'terminate') {
    return { version: 1, auth: value.auth, type: value.type }
  }
  if (value.type === 'attach' || value.type === 'resize') {
    if (typeof value.cols !== 'number' || typeof value.rows !== 'number') return null
    return { version: 1, auth: value.auth, type: value.type, cols: value.cols, rows: value.rows }
  }
  if (value.type === 'input' && typeof value.data === 'string') {
    return { version: 1, auth: value.auth, type: 'input', data: value.data }
  }
  return null
}

export function parseBrokerMessage(value: unknown): ConptyBrokerMessage | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== 'string') return null
  if (value.type === 'output' && typeof value.data === 'string') return { version: 1, type: 'output', data: value.data }
  if (value.type === 'exit' && (typeof value.exitCode === 'number' || value.exitCode === null)) {
    return { version: 1, type: 'exit', exitCode: value.exitCode }
  }
  if (value.type === 'terminated') return { version: 1, type: 'terminated' }
  if (value.type === 'error' && typeof value.code === 'string' && typeof value.message === 'string') {
    return { version: 1, type: 'error', code: value.code, message: value.message }
  }
  if ((value.type === 'inspect-result' || value.type === 'attached')
    && typeof value.brokerPid === 'number' && typeof value.shellPid === 'number') {
    if (value.type === 'inspect-result' && typeof value.alive === 'boolean') {
      return { version: 1, type: 'inspect-result', alive: value.alive, brokerPid: value.brokerPid, shellPid: value.shellPid }
    }
    if (value.type === 'attached') {
      return { version: 1, type: 'attached', brokerPid: value.brokerPid, shellPid: value.shellPid }
    }
  }
  return null
}

/** 无 attach 时只保留最后一段有界输出，避免常驻 broker 无限吃内存。 */
export class BoundedTerminalBuffer {
  private value = ''
  constructor(readonly maxBytes = CONPTY_BROKER_MAX_BUFFERED_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('缓冲上限必须是正整数')
  }

  push(data: string): void {
    this.value += data
    while (byteLength(this.value) > this.maxBytes && this.value.length > 0) {
      const overflow = byteLength(this.value) - this.maxBytes
      // 先按 UTF-16 字符估计裁剪，再校正；不会从半个代理对开始输出。
      let cut = Math.max(1, Math.min(this.value.length, overflow))
      if (cut < this.value.length && isLowSurrogate(this.value.charCodeAt(cut))) cut += 1
      this.value = this.value.slice(cut)
    }
  }

  drain(): string {
    const output = this.value
    this.value = ''
    return output
  }

  /** 返回有界输出副本但不清空，供 DSH 重启后的新 attach 回放。 */
  snapshot(): string {
    return this.value
  }

  get byteLength(): number {
    return byteLength(this.value)
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
