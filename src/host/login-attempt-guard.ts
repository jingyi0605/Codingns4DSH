import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const FAILURE_WINDOW_MS = 15 * 60 * 1000
const CAPTCHA_FAILURE_THRESHOLD = 3
const SOURCE_FAILURE_LIMIT = 12
const GLOBAL_FAILURE_LIMIT = 60
const BLOCK_DURATION_MS = 60 * 1000
const CAPTCHA_TTL_MS = 5 * 60 * 1000
const CAPTCHA_ATTEMPT_LIMIT = 3
const MAX_FAILURE_BUCKETS = 4096
const MAX_CAPTCHAS = 1024
const CAPTCHA_ALPHABET = '23456789'
const CAPTCHA_GLYPHS: Readonly<Record<string, readonly string[]>> = {
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
}

export interface LoginAttemptContext {
  readonly ipAddress: string
  readonly deviceFingerprint: string
}

export interface LoginCaptchaChallenge {
  readonly id: string
  readonly expiresAt: number
}

export type LoginAttemptDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'captcha_required' | 'captcha_invalid' | 'rate_limited'; readonly retryAfterSeconds: number }

interface FailureBucket {
  count: number
  firstFailureAt: number
  blockedUntil: number
}

interface CaptchaRecord extends LoginCaptchaChallenge {
  readonly deviceFingerprint: string
  readonly answer: string
  readonly svg: string
  attemptsLeft: number
}

/**
 * 登录入口的本地失败计数器。
 *
 * 计数只存在当前 Host 进程中，适合私人单实例站点；它限制的是在线尝试速度，
 * 不承担持久化会话撤销职责。来源 IP、设备特征和全局入口分别计数，任一维度
 * 进入冷却期都会拒绝新的登录尝试。
 */
export class LoginAttemptGuard {
  private readonly buckets = new Map<string, FailureBucket>()
  private readonly captchas = new Map<string, CaptchaRecord>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  beforeLogin(
    context: LoginAttemptContext,
    options: { readonly captchaId?: string; readonly captchaCode?: string; readonly allowCaptcha?: boolean } = {},
  ): LoginAttemptDecision {
    this.prune()
    const blockedUntil = this.blockedUntil(context)
    if (blockedUntil > this.now()) return { allowed: false, reason: 'rate_limited', retryAfterSeconds: secondsUntil(blockedUntil, this.now()) }

    if (!this.requiresCaptcha(context) || options.allowCaptcha === false) return { allowed: true }
    if (typeof options.captchaId !== 'string' || typeof options.captchaCode !== 'string' || !this.consumeCaptcha(options.captchaId, options.captchaCode, context)) {
      this.recordFailure(context)
      const nextBlockedUntil = this.blockedUntil(context)
      return {
        allowed: false,
        reason: 'captcha_invalid',
        retryAfterSeconds: nextBlockedUntil > this.now() ? secondsUntil(nextBlockedUntil, this.now()) : 1,
      }
    }
    return { allowed: true }
  }

  recordFailure(context: LoginAttemptContext): void {
    const timestamp = this.now()
    for (const key of contextKeys(context)) {
      const current = this.buckets.get(key)
      const bucket = current === undefined || timestamp - current.firstFailureAt >= FAILURE_WINDOW_MS
        ? { count: 0, firstFailureAt: timestamp, blockedUntil: 0 }
        : current
      bucket.count += 1
      if (bucket.count >= failureLimitFor(key)) bucket.blockedUntil = Math.max(bucket.blockedUntil, timestamp + BLOCK_DURATION_MS)
      this.buckets.set(key, bucket)
    }
    this.trimMap(this.buckets, MAX_FAILURE_BUCKETS)
  }

  recordSuccess(context: LoginAttemptContext): void {
    for (const key of contextKeys(context)) this.buckets.delete(key)
  }

  requiresCaptcha(context: LoginAttemptContext): boolean {
    this.prune()
    return contextKeys(context).some((key) => (this.buckets.get(key)?.count ?? 0) >= CAPTCHA_FAILURE_THRESHOLD)
  }

  issueCaptcha(context: LoginAttemptContext): LoginCaptchaChallenge {
    this.prune()
    for (const [id, record] of this.captchas) {
      if (record.deviceFingerprint === context.deviceFingerprint) this.captchas.delete(id)
    }
    const id = randomBytes(18).toString('base64url')
    const expiresAt = this.now() + CAPTCHA_TTL_MS
    const answer = randomCaptchaCode()
    this.captchas.set(id, {
      id,
      expiresAt,
      deviceFingerprint: context.deviceFingerprint,
      answer,
      svg: renderCaptchaSvg(answer),
      attemptsLeft: CAPTCHA_ATTEMPT_LIMIT,
    })
    this.trimMap(this.captchas, MAX_CAPTCHAS)
    return { id, expiresAt }
  }

  renderCaptcha(id: string, context: LoginAttemptContext): string | undefined {
    this.prune()
    const record = this.captchas.get(id)
    return record !== undefined && record.deviceFingerprint === context.deviceFingerprint ? record.svg : undefined
  }

  reset(): void {
    this.buckets.clear()
    this.captchas.clear()
  }

  private consumeCaptcha(id: string, code: string, context: LoginAttemptContext): boolean {
    const record = this.captchas.get(id)
    if (record === undefined || record.deviceFingerprint !== context.deviceFingerprint || record.expiresAt <= this.now()) return false
    const expected = Buffer.from(record.answer)
    const actual = Buffer.from(code.trim().toUpperCase())
    const valid = expected.length === actual.length && timingSafeEqual(expected, actual)
    if (valid || --record.attemptsLeft <= 0) this.captchas.delete(id)
    return valid
  }

  private blockedUntil(context: LoginAttemptContext): number {
    return Math.max(...contextKeys(context).map((key) => this.buckets.get(key)?.blockedUntil ?? 0))
  }

  private prune(): void {
    const timestamp = this.now()
    for (const [key, bucket] of this.buckets) {
      if (timestamp - bucket.firstFailureAt >= FAILURE_WINDOW_MS && bucket.blockedUntil <= timestamp) this.buckets.delete(key)
    }
    for (const [id, captcha] of this.captchas) if (captcha.expiresAt <= timestamp) this.captchas.delete(id)
  }

  private trimMap<T>(values: Map<string, T>, limit: number): void {
    while (values.size > limit) {
      const oldest = values.keys().next().value
      if (oldest === undefined) return
      values.delete(oldest)
    }
  }
}

/** 从真实 TCP 对端地址和请求头派生设备特征，不信任客户端自报的身份字段。 */
export function createLoginAttemptContext(ipAddress: string | undefined, headers: Readonly<Record<string, string>>): LoginAttemptContext {
  const normalizedIp = ipAddress?.trim() || 'unknown'
  const fingerprintInput = [
    headers['user-agent'] ?? '',
    headers['accept-language'] ?? '',
    headers['sec-ch-ua'] ?? '',
    headers['sec-ch-ua-platform'] ?? '',
    headers['sec-ch-ua-mobile'] ?? '',
  ].join('\n')
  return {
    ipAddress: normalizedIp,
    deviceFingerprint: createHash('sha256').update(fingerprintInput || 'unknown-device').digest('hex'),
  }
}

function contextKeys(context: LoginAttemptContext): readonly string[] {
  return [`ip:${context.ipAddress}`, `device:${context.deviceFingerprint}`, 'global']
}

function failureLimitFor(key: string): number {
  return key === 'global' ? GLOBAL_FAILURE_LIMIT : SOURCE_FAILURE_LIMIT
}

function secondsUntil(deadline: number, timestamp: number): number {
  return Math.max(1, Math.ceil((deadline - timestamp) / 1000))
}

function randomCaptchaCode(): string {
  const bytes = randomBytes(5)
  return Array.from(bytes, (byte: number) => CAPTCHA_ALPHABET[byte % CAPTCHA_ALPHABET.length]).join('')
}

function renderCaptchaSvg(answer: string): string {
  const lines = Array.from({ length: 7 }, (_, index) => {
    const x1 = 8 + (index * 19) % 120
    const y1 = 8 + (index * 13) % 42
    const x2 = 18 + (index * 31) % 120
    const y2 = 48 - (index * 7) % 35
    return `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="hsl(${(index * 47) % 360} 70% 62%)" stroke-width="1.2" opacity=".65"/>`
  }).join('')
  const dots = Array.from({ length: 28 }, (_, index) => `<circle cx="${(index * 37) % 132 + 4}" cy="${(index * 19) % 48 + 2}" r="${index % 3 === 0 ? 1.2 : 0.7}" fill="#94a3b8" opacity=".55"/>`).join('')
  const glyphs = Array.from(answer, (character, index) => {
    const rows = CAPTCHA_GLYPHS[character] ?? CAPTCHA_GLYPHS['8']!
    const cells = rows.flatMap((row, rowIndex) => Array.from(row, (cell, columnIndex) => (
      cell === '1' ? `M${12 + index * 24 + columnIndex * 3} ${14 + rowIndex * 3}h3v3h-3z` : ''
    ))).join('')
    const centerX = 19 + index * 24
    return `<path d="${cells}" transform="rotate(${(index % 3 - 1) * 8} ${centerX} 25)" fill="hsl(${(index * 61 + 190) % 360} 90% 78%)"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="52" viewBox="0 0 140 52" role="img" aria-label="图形验证码"><rect width="140" height="52" rx="7" fill="#0f172a"/>${lines}${dots}${glyphs}</svg>`
}
