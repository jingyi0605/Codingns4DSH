import { resolveCodingNsDebugLevel, type CodingNsDebugLevel } from '../shared/debug.js'

/**
 * DSH Tunnel 调试日志。
 *
 * 日志只接受调用方明确传入的协议元数据，禁止把 Envelope body、票据、Cookie
 * 或本地 Web 响应正文交给这个模块。默认关闭，生产环境不会产生额外输出。
 */

export type DshTransportDebugSide = 'h5' | 'host' | 'relay' | 'unknown'

export interface DshTransportDebugLogger {
  readonly enabled: boolean
  readonly level: CodingNsDebugLevel
  log(event: string, fields?: Readonly<Record<string, unknown>>): void
}

export interface DshTransportDebugOptions {
  readonly enabled?: boolean
  readonly level?: CodingNsDebugLevel
  readonly side?: DshTransportDebugSide
  readonly component?: string
  readonly sink?: (record: Readonly<Record<string, unknown>>) => void
}

/** 创建一个可注入测试 sink 的调试 logger。默认开关由当前运行环境决定。 */
export function createDshTransportDebugLogger(options: DshTransportDebugOptions = {}): DshTransportDebugLogger {
  const level = options.level ?? (options.enabled === undefined
    ? resolveDshTransportDebugLevel()
    : options.enabled ? 'info' : 'off')
  const enabled = level !== 'off'
  const side = options.side ?? 'unknown'
  const component = options.component ?? 'transport'
  const sink = options.sink ?? ((record) => {
    // console.info 在 Node 和浏览器中都能稳定显示，并且不会把正文拼进字符串。
    if (level === 'warn') console.warn('[codingns4dsh:tunnel]', record)
    else console.info('[codingns4dsh:tunnel]', record)
  })
  return {
    enabled,
    level,
    log(event, fields = {}) {
      if (!enabled || (level === 'warn' && !isDshTransportWarningEvent(event, fields))) return
      sink({
        at: new Date().toISOString(),
        side,
        component,
        event,
        ...sanitizeDshTransportDebugFields(fields),
      })
    },
  }
}

/** 诊断级别为 warn 时，只保留能代表异常或降级的 Transport 事件。 */
export function isDshTransportWarningEvent(event: string, fields: Readonly<Record<string, unknown>> = {}): boolean {
  if (/(?:^|\.)(?:warn|warning|error|failed|invalid|rejected|drop|unavailable|timeout)(?:$|\.)/iu.test(event)) return true
  if (typeof fields.status === 'number' && fields.status >= 400) return true
  if (typeof fields.state === 'string' && /^(failed|disconnected|closed|degraded)$/iu.test(fields.state)) return true
  if (typeof fields.event === 'string' && fields.event !== event) {
    const nestedFields = isRecord(fields.fields) ? fields.fields : {}
    return isDshTransportWarningEvent(fields.event, nestedFields)
  }
  return false
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 调试字段采用正向白名单。Transport 可能同时处理 token、URL、命令和正文，
 * 因此不能依赖调用方自觉脱敏；未知字段和错误正文直接丢弃。
 *
 * `path` / `method` / `status` / `errorCode` 是 DSH Web 请求的路由元数据：
 * 没有它们就无法区分「请求没到达 Host」和「请求到达但返回空结果」，
 * 中继设置页空白这类问题只能靠日志猜。这些字段只能是 HTTP 路径与状态，
 * 禁止把查询串、Cookie、请求/响应正文塞进来。
 */
export function sanitizeDshTransportDebugFields(fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const allowed = new Set([
    'bytes', 'physicalBytes', 'bodyBytes', 'sdpBytes', 'streamId', 'messageId', 'sessionId',
    'generation', 'previousGeneration', 'hostId', 'expectedHostId', 'hostKind', 'expectedHostKind',
    'channel', 'channelLabel', 'operation', 'feature', 'type', 'code', 'state', 'role',
    'streams', 'activeStreams', 'openingStreams', 'maxStreams', 'fragmentId', 'chunkCount',
    'totalBytes', 'payloadBytes', 'bufferedAmount', 'highWaterMark', 'lowWaterMark', 'dataType',
    'valueType', 'trafficRemainingBytes', 'path', 'method', 'status', 'errorCode',
    // 候选计数用于定位「answer 先到、候选被丢弃」这类连接慢的问题，只记数量不记候选内容。
    'candidateCount', 'applied', 'waitMs', 'attempt',
  ])
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key)) continue
    if (typeof value === 'string') {
      result[key] = key === 'path' ? sanitizeDebugPath(value) : value
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) result[key] = value
  }
  return result
}

/** 路径只保留 pathname，去掉查询串与可能带凭据的片段。 */
function sanitizeDebugPath(value: string): string {
  const query = value.indexOf('?')
  const trimmed = query === -1 ? value : value.slice(0, query)
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}

/** 解析统一的 Codingns4DSH 调试开关，保留旧隧道变量作为兼容别名。 */
export function resolveDshTransportDebugEnabled(): boolean {
  return resolveDshTransportDebugLevel() !== 'off'
}

/** 返回 Transport 调试日志级别。 */
export function resolveDshTransportDebugLevel(): CodingNsDebugLevel {
  return resolveCodingNsDebugLevel()
}
