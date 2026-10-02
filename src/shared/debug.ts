/**
 * Codingns4DSH 调试日志开关。
 *
 * 调试输出默认关闭。需要查看启动或 RPC 追踪时，使用
 * `CODINGNS4DSH_DEBUG=1 dsh ...` 启动 DSH；浏览器侧同时支持 `?dshDebug=1`。
 * 只看警告和错误时使用 `CODINGNS4DSH_DEBUG_LEVEL=warn`，也接受
 * `CODINGNS4DSH_DEBUG=warn` 作为简写。
 */
export const CODINGNS4DSH_DEBUG_ENV = 'CODINGNS4DSH_DEBUG'
export const CODINGNS4DSH_DEBUG_LEVEL_ENV = 'CODINGNS4DSH_DEBUG_LEVEL'
/** 兼容脚本化启动器的显式警告模式开关。 */
export const CODINGNS4DSH_DEBUG_WARN_ENV = 'CODINGNS4DSH_DEBUG_WARN'

const LEGACY_DEBUG_ENV = 'CODINGNS4DSH_TUNNEL_DEBUG'

export type CodingNsDebugLevel = 'off' | 'warn' | 'info'

/** 当前运行环境是否明确要求输出调试日志。 */
export function resolveCodingNsDebugEnabled(): boolean {
  return resolveCodingNsDebugLevel() !== 'off'
}

/** 解析调试日志级别；`warn` 会过滤普通追踪信息，只保留警告和错误。 */
export function resolveCodingNsDebugLevel(): CodingNsDebugLevel {
  const globals = globalThis as typeof globalThis & {
    __CODINGNS4DSH_DEBUG_ENABLED__?: unknown
    __CODINGNS4DSH_DEBUG_LEVEL__?: unknown
    __CODINGNS4DSH_TUNNEL_DEBUG__?: unknown
  }
  if (globals.__CODINGNS4DSH_DEBUG_LEVEL__ !== undefined) {
    return parseDebugLevel(globals.__CODINGNS4DSH_DEBUG_LEVEL__)
  }
  const globalValue = globals.__CODINGNS4DSH_DEBUG_ENABLED__ ?? globals.__CODINGNS4DSH_TUNNEL_DEBUG__
  if (globalValue !== undefined) return parseDebugValue(globalValue) ? 'info' : 'off'

  if (typeof location !== 'undefined') {
    const searchParams = new URL(location.href).searchParams
    const queryValue = searchParams.get('dshDebugLevel') ?? searchParams.get('dshDebug')
    if (queryValue !== null) return parseDebugLevel(queryValue)
  }

  if (typeof localStorage !== 'undefined') {
    try {
      const storedLevel = localStorage.getItem('codingns4dsh-debug-level')
      if (storedLevel !== null) return parseDebugLevel(storedLevel)
      const storedWarn = localStorage.getItem('codingns4dsh-debug-warn')
      if (storedWarn !== null && parseDebugValue(storedWarn)) return 'warn'
      const stored = localStorage.getItem('codingns4dsh-debug')
        ?? localStorage.getItem('codingns4dsh-tunnel-debug')
      if (stored !== null) return parseDebugLevel(stored)
    } catch {
      // 隐私模式或受限 iframe 可能禁止读取 localStorage，继续检查进程环境变量。
    }
  }

  if (typeof process !== 'undefined') {
    const level = process.env[CODINGNS4DSH_DEBUG_LEVEL_ENV]
    if (level !== undefined) return parseDebugLevel(level)
    if (parseDebugValue(process.env[CODINGNS4DSH_DEBUG_WARN_ENV])) return 'warn'
    return parseDebugLevel(process.env[CODINGNS4DSH_DEBUG_ENV] ?? process.env[LEGACY_DEBUG_ENV])
  }
  return 'off'
}

/** 输出受统一开关控制的调试信息。 */
export function debugInfo(message: unknown, ...args: unknown[]): void {
  if (resolveCodingNsDebugLevel() === 'info') console.info(message, ...args)
}

/** 输出受统一开关控制的调试警告。 */
export function debugWarn(message: unknown, ...args: unknown[]): void {
  if (resolveCodingNsDebugEnabled()) console.warn(message, ...args)
}

function parseDebugValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  return /^(1|true|yes|on)$/iu.test(value.trim())
}

function parseDebugLevel(value: unknown): CodingNsDebugLevel {
  if (typeof value === 'boolean') return value ? 'info' : 'off'
  if (typeof value !== 'string') return 'off'
  const normalized = value.trim().toLowerCase()
  if (/^(warn|warning|error)$/u.test(normalized)) return 'warn'
  if (/^(1|true|yes|on|info|debug)$/u.test(normalized)) return 'info'
  return 'off'
}
