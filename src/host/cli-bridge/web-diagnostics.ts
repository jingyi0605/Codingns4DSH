/**
 * 外部 CLI 联网搜索/抓取的失败诊断。
 *
 * DSH 的 `ctx.web` 连接层（undici）在传输失败时只抛 `TypeError: fetch failed`，
 * 真正的原因在 `error.cause` 上（`ENOTFOUND`、`ECONNRESET`、`UND_ERR_*` 等）。
 * provider 又会把这条信息包装成“请检查 base URL”，外部 Agent 因此只能看到
 * `fetch failed`，误判为“搜索接口不可用”。这里统一把原因链解成稳定诊断，
 * 并给出是否值得重试的判断。
 *
 * 只读取错误对象上的字段，绝不包含查询文本、URL 凭据或响应正文。
 */

/** 传输层可重试的底层错误码；对应一次网络抖动，而不是配置或鉴权问题。 */
const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  // undici 在连接、响应头、响应体阶段各自的超时与中断。
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_ABORTED',
])

/**
 * 明确不可重试的 WebError 代码。凭据缺失或配置错误时重试只会重复失败，
 * 而且会把一个需要用户处理的问题拖成多次网络请求。
 */
const NON_RETRYABLE_WEB_CODES = new Set([
  'WEB_PROVIDER_CREDENTIAL_MISSING',
  'WEB_PROVIDER_MISCONFIGURED',
  'WEB_ABORTED',
  'WEB_URL_BLOCKED',
  'WEB_INVALID_URL',
])

/** 诊断链最多展开的层数，避免异常环或超长 cause 链拖垮日志。 */
const MAX_CAUSE_DEPTH = 4

export interface WebFailureDiagnostics {
  /** 是否属于网络抖动，值得用同一参数再试一次。 */
  readonly retryable: boolean
  /** 从原因链提取的底层错误码，由近及远。 */
  readonly causes: readonly string[]
  /** 面向模型的稳定说明，追加在原始消息之后。 */
  readonly detail?: string
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function isAbortError(error: unknown): boolean {
  const record = recordOf(error)
  return record?.name === 'AbortError' || record?.name === 'TimeoutError'
}

/**
 * 沿 `cause` 链收集底层错误码与系统调用信息。
 *
 * undici 把多个地址的失败合并成 `AggregateError` 放在 `cause.errors` 里；
 * 只取第一个可读的码即可，标签写清是哪一类错误。
 */
function collectCauses(error: unknown): { codes: string[]; target?: string; timedOut: boolean } {
  const codes: string[] = []
  let target: string | undefined
  let timedOut = false
  let current: unknown = recordOf(error)?.cause
  for (let depth = 0; current !== undefined && depth < MAX_CAUSE_DEPTH; depth += 1) {
    const record = recordOf(current)
    if (record === undefined) break
    const code = textOf(record.code)
    if (code !== undefined) codes.push(code)
    const host = textOf(record.hostname)
    const address = textOf(record.address)
    target ??= host ?? address
    if (record.name === 'TimeoutError') timedOut = true
    // AggregateError.errors 与 cause 同层展开，保持由近及远。
    const errors: unknown = record.errors
    if (Array.isArray(errors)) {
      for (const nested of errors) {
        const nestedRecord = recordOf(nested)
        if (nestedRecord === undefined) continue
        const nestedCode = textOf(nestedRecord.code)
        const nestedHost = textOf(nestedRecord.hostname) ?? textOf(nestedRecord.address)
        if (nestedCode !== undefined) codes.push(nestedCode)
        target ??= nestedHost
      }
    }
    current = record.cause
  }
  return target === undefined ? { codes, timedOut } : { codes, target, timedOut }
}

function webCodeOf(error: unknown): string | undefined {
  const record = recordOf(error)
  for (const key of ['code', 'errorCode', 'error_code'] as const) {
    const value = textOf(record?.[key])
    if (value !== undefined) return value
  }
  return undefined
}

/** HTTP 状态码：provider 在上游返回 4xx/5xx 时会把状态挂在错误上。 */
function statusOf(error: unknown): number | undefined {
  const record = recordOf(error)
  for (const key of ['status', 'statusCode'] as const) {
    const value = record?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * 判断一次失败是否值得原样重试。
 *
 * 只承认明确的传输抖动；配置、鉴权、URL 拒绝和调用方取消都不重试。没有可识别
 * 错误码的 `fetch failed` 仍按可重试处理，因为这是 undici 最常见的瞬时失败形态。
 */
export function isRetryableWebFailure(error: unknown): boolean {
  if (isAbortError(error)) return false
  const webCode = webCodeOf(error)
  if (webCode !== undefined && NON_RETRYABLE_WEB_CODES.has(webCode)) return false
  // 其他 WEB_* 代码来自 provider 的结构化失败；只有明确的传输码才重试。
  if (webCode !== undefined && /^WEB_/u.test(webCode) && !RETRYABLE_CODES.has(webCode)) return false
  if (statusOf(error) !== undefined) return false
  if (webCode !== undefined && RETRYABLE_CODES.has(webCode)) return true
  const { codes } = collectCauses(error)
  if (codes.some((code) => RETRYABLE_CODES.has(code))) return true
  // 无码的 `fetch failed`：undici 未把 cause 传出来时的兜底，只重试一次。
  const record = recordOf(error)
  return record?.name === 'TypeError' && String(record.message).startsWith('fetch failed')
}

/**
 * 生成失败诊断：可重试判断、原因码和一句面向模型的稳定说明。
 *
 * 说明只拼接错误码与目标主机，不回显查询、页面地址或响应正文。
 */
export function describeWebFailure(error: unknown): WebFailureDiagnostics {
  const retryable = isRetryableWebFailure(error)
  const { codes, target, timedOut } = collectCauses(error)
  const unique = [...new Set(codes)]
  const record = recordOf(error)
  const message = String(record?.message ?? error)
  const status = statusOf(error)
  const parts: string[] = []
  if (isAbortError(error)) parts.push(timedOut || record?.name === 'TimeoutError' ? 'the request timed out' : 'the request was cancelled')
  else if (status !== undefined) parts.push(`upstream returned HTTP ${String(status)}`)
  else if (unique.length > 0) parts.push(`transport error ${unique.join('/')}`)
  else if (retryable) parts.push('transport error without a cause code')
  if (target !== undefined) parts.push(`target ${target}`)
  if (parts.length === 0) return { retryable, causes: unique }
  const retryHint = retryable ? 'A retry of the same call may succeed.' : 'Retrying the same call will not help; this needs configuration or user action.'
  return {
    retryable,
    causes: unique,
    detail: `${message} (${parts.join(', ')}). ${retryHint}`,
  }
}
