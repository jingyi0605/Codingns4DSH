/**
 * Web Push 发送器（VAPID + RFC 8291 aes128gcm）。
 *
 * 自实现而非引入依赖：需要的原语（P-256 ECDH、HKDF-SHA256、AES-128-GCM、ES256 签名）
 * 都在 node:crypto 里。载荷只包含标题、摘要与会话标识，密钥与订阅文件都在 Host
 * 私有目录（0600），不会下发到浏览器。
 */
import { createCipheriv, createECDH, createHmac, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface PwaPushSubscriptionInput {
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
}

export interface PwaPushSubscriptionRecord {
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
  readonly createdAt: string
  /** 设备摘要（UA 截断），不含任何凭据。 */
  readonly label: string
}

export interface PwaPushPayload {
  readonly title: string
  readonly body?: string
  readonly url?: string
  readonly tag?: string
}

export interface PwaPushVapidKeys {
  /** 非压缩点（65 字节）的 base64url，可直接作为 applicationServerKey。 */
  readonly publicKey: string
  /** 私有 JWK（含 d），只保存在 Host。 */
  readonly privateKeyJwk: Record<string, string>
  readonly createdAt: string
}

export interface PwaPushSendResult {
  readonly ok: boolean
  readonly status: number
  readonly expired: boolean
  readonly error?: string
}

export interface PwaPushServiceOptions {
  /** 状态目录，默认 `~/.config/codingns4dsh`。 */
  readonly stateDir?: string
  readonly fetchImpl?: typeof fetch
  /** VAPID subject（JWT sub），默认 mailto 指向本机。 */
  readonly subject?: string
  readonly now?: () => number
}

const VAPID_FILE = 'pwa-vapid.json'
const SUBSCRIPTIONS_FILE = 'pwa-push-subscriptions.json'
const RECORD_SIZE = 4096
const DEFAULT_TTL_SECONDS = 60

export class PwaPushService {
  private readonly stateDir: string
  private readonly fetchImpl: typeof fetch
  private readonly subject: string
  private readonly now: () => number
  private vapidCache: PwaPushVapidKeys | null = null

  constructor(options: PwaPushServiceOptions = {}) {
    const configured = process.env.CODINGNS4DSH_STATE_DIR?.trim()
    this.stateDir = options.stateDir ?? (configured === undefined || configured === '' ? join(homedir(), '.config', 'codingns4dsh') : configured)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.subject = options.subject ?? 'mailto:codingns4dsh@localhost'
    this.now = options.now ?? (() => Date.now())
  }

  /** 读取或生成 VAPID 密钥；公钥同时返回给浏览器用于订阅。 */
  async vapidKeys(): Promise<PwaPushVapidKeys> {
    if (this.vapidCache !== null) return this.vapidCache
    const path = join(this.stateDir, VAPID_FILE)
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
      const keys = parseVapidKeys(parsed)
      if (keys !== null) {
        this.vapidCache = keys
        return keys
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
    const keys = generateVapidKeys(this.now())
    await this.writeJson(path, keys)
    this.vapidCache = keys
    return keys
  }

  async listSubscriptions(): Promise<readonly PwaPushSubscriptionRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(join(this.stateDir, SUBSCRIPTIONS_FILE), 'utf8')) as unknown
      return parseSubscriptions(parsed)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return []
      throw error
    }
  }

  /** 写入订阅并按 endpoint 去重；label 只保留 UA 摘要。 */
  async subscribe(input: PwaPushSubscriptionInput, label: string): Promise<PwaPushSubscriptionRecord> {
    const endpoint = requireEndpoint(input.endpoint)
    const p256dh = requireBase64Url(input.keys.p256dh, 'p256dh')
    const auth = requireBase64Url(input.keys.auth, 'auth')
    const record: PwaPushSubscriptionRecord = {
      endpoint,
      keys: { p256dh, auth },
      createdAt: new Date(this.now()).toISOString(),
      label: sanitizeLabel(label),
    }
    const existing = await this.listSubscriptions()
    const next = [...existing.filter((item) => item.endpoint !== endpoint), record]
    await this.writeJson(join(this.stateDir, SUBSCRIPTIONS_FILE), next)
    return record
  }

  async unsubscribe(endpoint: string): Promise<boolean> {
    const existing = await this.listSubscriptions()
    const next = existing.filter((item) => item.endpoint !== endpoint)
    if (next.length === existing.length) return false
    await this.writeJson(join(this.stateDir, SUBSCRIPTIONS_FILE), next)
    return true
  }

  /** 发送单条推送；404/410 表示订阅已失效，由调用方决定清理。 */
  async send(subscription: PwaPushSubscriptionRecord, payload: PwaPushPayload, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<PwaPushSendResult> {
    try {
      const keys = await this.vapidKeys()
      const body = encryptPushPayload(new TextEncoder().encode(JSON.stringify({
        title: payload.title,
        ...(payload.body === undefined ? {} : { body: payload.body }),
        ...(payload.url === undefined ? {} : { url: payload.url }),
        ...(payload.tag === undefined ? {} : { tag: payload.tag }),
      })), subscription.keys)
      const token = createVapidToken({
        endpoint: subscription.endpoint,
        subject: this.subject,
        publicKey: keys.publicKey,
        privateKeyJwk: keys.privateKeyJwk,
        nowSeconds: Math.floor(this.now() / 1000),
      })
      const response = await this.fetchImpl(subscription.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `vapid t=${token}, k=${keys.publicKey}`,
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(ttlSeconds),
        },
        body: toArrayBuffer(body),
      })
      const expired = response.status === 404 || response.status === 410
      return { ok: response.ok, status: response.status, expired, ...(response.ok ? {} : { error: `HTTP ${response.status}` }) }
    } catch (error) {
      return { ok: false, status: 0, expired: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 广播：失效订阅顺手清理，返回统计供设置页展示。 */
  async sendToAll(payload: PwaPushPayload): Promise<{ sent: number; failed: number; removed: number; total: number }> {
    const subscriptions = await this.listSubscriptions()
    let sent = 0
    let failed = 0
    let removed = 0
    for (const subscription of subscriptions) {
      const result = await this.send(subscription, payload)
      if (result.ok) sent += 1
      else if (result.expired) {
        removed += 1
        await this.unsubscribe(subscription.endpoint)
      } else failed += 1
    }
    return { sent, failed, removed, total: subscriptions.length }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
  }
}

function generateVapidKeys(createdAt: number): PwaPushVapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const publicKey = ecdh.getPublicKey()
  const privateKey = ecdh.getPrivateKey()
  const privateKeyJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: publicKey.subarray(1, 33).toString('base64url'),
    y: publicKey.subarray(33, 65).toString('base64url'),
    d: privateKey.toString('base64url'),
  }
  return { publicKey: publicKey.toString('base64url'), privateKeyJwk, createdAt: new Date(createdAt).toISOString() }
}

function parseVapidKeys(value: unknown): PwaPushVapidKeys | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const publicKey = record.publicKey
  const privateKeyJwk = record.privateKeyJwk
  if (typeof publicKey !== 'string' || Buffer.from(publicKey, 'base64url').length !== 65) return null
  if (typeof privateKeyJwk !== 'object' || privateKeyJwk === null) return null
  const jwk = privateKeyJwk as Record<string, unknown>
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null
  return {
    publicKey,
    privateKeyJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d },
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
  }
}

function parseSubscriptions(value: unknown): PwaPushSubscriptionRecord[] {
  if (!Array.isArray(value)) return []
  const records: PwaPushSubscriptionRecord[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const keys = record.keys
    if (typeof record.endpoint !== 'string' || typeof keys !== 'object' || keys === null) continue
    const keyRecord = keys as Record<string, unknown>
    if (typeof keyRecord.p256dh !== 'string' || typeof keyRecord.auth !== 'string') continue
    records.push({
      endpoint: record.endpoint,
      keys: { p256dh: keyRecord.p256dh, auth: keyRecord.auth },
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(),
      label: typeof record.label === 'string' ? record.label : '',
    })
  }
  return records
}

function createVapidToken(input: {
  readonly endpoint: string
  readonly subject: string
  readonly publicKey: string
  readonly privateKeyJwk: Record<string, string>
  readonly nowSeconds: number
}): string {
  const audience = new URL(input.endpoint).origin
  const header = base64UrlJson({ typ: 'JWT', alg: 'ES256' })
  const payload = base64UrlJson({ aud: audience, exp: input.nowSeconds + 12 * 3600, sub: input.subject })
  const signingInput = `${header}.${payload}`
  const key = createPrivateKey({ key: input.privateKeyJwk, format: 'jwk' })
  // ieee-p1363 直接输出 r||s，避免 DER 转换。
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${signature.toString('base64url')}`
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** RFC 8291 单记录加密；返回可直接作为请求正文的字节。 */
export function encryptPushPayload(payload: Uint8Array, keys: { readonly p256dh: string; readonly auth: string }): Uint8Array {
  const clientPublic = Buffer.from(keys.p256dh, 'base64url')
  const authSecret = Buffer.from(keys.auth, 'base64url')
  if (clientPublic.length !== 65) throw new Error('p256dh 必须是 65 字节的非压缩公钥')
  if (authSecret.length !== 16) throw new Error('auth secret 必须是 16 字节')
  const server = createECDH('prime256v1')
  server.generateKeys()
  const serverPublic = server.getPublicKey()
  const sharedSecret = server.computeSecret(clientPublic)
  const info = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), clientPublic, serverPublic])
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, info, 32))
  const salt = randomBytes(16)
  const prk = hkdfExtract(salt, ikm)
  const cek = hkdfExpand(prk, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
  const nonce = hkdfExpand(prk, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([0x02])])
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(serverPublic.length, 20)
  return Buffer.concat([header, serverPublic, ciphertext])
}

function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Buffer {
  return createHmac('sha256', salt).update(ikm).digest()
}

function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Buffer {
  const blocks = Math.ceil(length / 32)
  let previous = Buffer.alloc(0)
  const output: Buffer[] = []
  for (let index = 1; index <= blocks; index += 1) {
    const hmac = createHmac('sha256', prk)
    hmac.update(previous)
    hmac.update(info)
    hmac.update(Buffer.from([index]))
    previous = hmac.digest()
    output.push(previous)
  }
  return Buffer.concat(output).subarray(0, length)
}

function requireEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('订阅 endpoint 必须是字符串')
  const trimmed = value.trim()
  if (trimmed.length < 8 || trimmed.length > 2048) throw new Error('订阅 endpoint 长度无效')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:') throw new Error('订阅 endpoint 必须是 https')
  return trimmed
}

function requireBase64Url(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/u.test(value) || value.length > 512) throw new Error(`${field} 不是合法的 base64url`)
  return value
}

function sanitizeLabel(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, 120)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}
