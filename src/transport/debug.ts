/**
 * DSH Tunnel 调试日志。
 *
 * 日志只接受调用方明确传入的协议元数据，禁止把 Envelope body、票据、Cookie
 * 或本地 Web 响应正文交给这个模块。默认关闭，生产环境不会产生额外输出。
 */
export type DshTransportDebugSide = 'h5' | 'host' | 'relay' | 'unknown'

export interface DshTransportDebugLogger {
  readonly enabled: boolean
  log(event: string, fields?: Readonly<Record<string, unknown>>): void
}

export interface DshTransportDebugOptions {
  readonly enabled?: boolean
  readonly side?: DshTransportDebugSide
  readonly component?: string
  readonly sink?: (record: Readonly<Record<string, unknown>>) => void
}

const DEBUG_ENV = 'DSH_CODINGNS_TUNNEL_DEBUG'

/** 创建一个可注入测试 sink 的调试 logger。默认开关由当前运行环境决定。 */
export function createDshTransportDebugLogger(options: DshTransportDebugOptions = {}): DshTransportDebugLogger {
  const enabled = options.enabled ?? resolveDshTransportDebugEnabled()
  const side = options.side ?? 'unknown'
  const component = options.component ?? 'transport'
  const sink = options.sink ?? ((record) => {
    // console.info 在 Node 和浏览器中都能稳定显示，并且不会把正文拼进字符串。
    console.info('[dsh-codingns:tunnel]', record)
  })
  return {
    enabled,
    log(event, fields = {}) {
      if (!enabled) return
      sink({
        at: new Date().toISOString(),
        side,
        component,
        event,
        ...fields,
      })
    },
  }
}

/** 解析 Host 环境变量、H5 URL/localStorage 和调试全局变量。 */
export function resolveDshTransportDebugEnabled(): boolean {
  const globalValue = (globalThis as typeof globalThis & { __DSH_CODINGNS_TUNNEL_DEBUG__?: unknown }).__DSH_CODINGNS_TUNNEL_DEBUG__
  if (globalValue !== undefined) return parseDebugValue(globalValue)

  if (typeof location !== 'undefined') {
    const queryValue = new URL(location.href).searchParams.get('dshDebug')
    if (queryValue !== null) return parseDebugValue(queryValue)
  }

  if (typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem('dsh-codingns-tunnel-debug')
      if (stored !== null) return parseDebugValue(stored)
    } catch {
      // 隐私模式或受限 iframe 可能禁止读取 localStorage，继续检查其他来源。
    }
  }

  if (typeof process !== 'undefined') return parseDebugValue(process.env[DEBUG_ENV])
  return false
}

function parseDebugValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  return /^(1|true|yes|on)$/iu.test(value.trim())
}
