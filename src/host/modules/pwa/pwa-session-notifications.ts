import type { PwaPushPayload } from './pwa-push.js'
import { hostBrowserText, type HostLocale } from '../../browser-text.js'

/** 会话事件通知的最小输入，避免通知模块依赖 DSH 私有 Session 类型。 */
export interface PwaSessionNotificationInput {
  readonly session: unknown
  readonly event: unknown
  /** Host 侧语言；缺省回退 `zh`，与改造前行为一致。 */
  readonly locale?: HostLocale
}

/**
 * 将 DSH 原生会话事件投影为 PWA 推送载荷。
 *
 * 原生事件在不同 DSH/Provider 版本中可能使用 type、method 或嵌套 data.type，
 * 因此这里只读取稳定字符串字段并按语义分类；无法识别的事件安静忽略。
 */
export function createPwaSessionNotification(input: PwaSessionNotificationInput): PwaPushPayload | null {
  const locale = input.locale ?? 'zh'
  const sessionId = readSessionId(input.session)
  if (sessionId === null) return null
  const eventType = readEventType(input.event)
  if (eventType === null) return null
  const normalized = normalizeEventType(eventType)
  const url = `/?sessionId=${encodeURIComponent(sessionId)}`
  if (normalized === 'turn_end' || normalized.endsWith('_turn_end')) {
    return {
      title: hostBrowserText(locale, 'push.turnEndTitle'),
      body: hostBrowserText(locale, 'push.turnEndBody', { sessionId }),
      tag: `codingns4dsh-turn-${sessionId}`,
      url,
    }
  }
  if (isWaitingEvent(normalized)) {
    return {
      title: hostBrowserText(locale, 'push.waitingTitle'),
      body: hostBrowserText(locale, 'push.waitingBody', { sessionId }),
      tag: `codingns4dsh-input-${sessionId}`,
      url,
    }
  }
  return null
}

function readSessionId(value: unknown): string | null {
  const record = asRecord(value)
  const id = record?.id ?? record?.sessionId ?? record?.session_id
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null
}

function readEventType(value: unknown): string | null {
  const record = asRecord(value)
  let fallback: string | null = null
  for (const candidate of [record?.type, record?.method, record?.name, record?.kind]) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    if (fallback === null) fallback = candidate
    if (!isGenericEventType(candidate)) return candidate
  }
  for (const key of ['data', 'event', 'payload', 'params']) {
    const nested = readEventType(record?.[key])
    if (nested !== null) return nested
  }
  return fallback
}

function isGenericEventType(value: string): boolean {
  const normalized = normalizeEventType(value)
  return normalized === 'event' || normalized === 'session_event' || normalized === 'notification'
}

function normalizeEventType(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[./-]+/gu, '_')
}

function isWaitingEvent(value: string): boolean {
  return value.includes('question')
    || value.includes('request_user_input')
    || value.includes('request_input')
    || value.includes('ask_user')
    || value.includes('permission')
    || value.includes('approval')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
