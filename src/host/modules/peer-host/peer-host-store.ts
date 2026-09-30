import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  PeerHostErrorCode,
  PeerHostRecord,
  PeerHostRoute,
} from '../../../shared/contracts/peer-host.js'
import { PEER_HOST_ERROR_CODES } from '../../../shared/contracts/peer-host.js'

export interface PeerHostTokenRecord {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
}

export interface PeerHostRecordStore {
  read(): Promise<readonly PeerHostRecord[]>
  write(records: readonly PeerHostRecord[]): Promise<void>
}

export interface PeerHostCredentialStore {
  read(peerHostId: string): Promise<PeerHostTokenRecord | null>
  write(peerHostId: string, credential: PeerHostTokenRecord): Promise<void>
  clear(peerHostId: string): Promise<void>
}

export interface PeerHostCreateInput {
  readonly displayName: string
  readonly route: PeerHostRoute
}

export interface PeerHostUpdateInput {
  readonly displayName?: string
  readonly route?: PeerHostRoute
}

export interface PeerHostHandshakeUpdate {
  readonly status: PeerHostRecord['status']
  readonly pluginId: string | null
  readonly pluginVersion: string | null
  readonly dshVersion: string | null
  readonly hostname?: string | null
  readonly configProfile?: string | null
  readonly apiCompatibility: string | null
  readonly fingerprint: string | null
  readonly lastCheckedAt: number
  readonly lastErrorCode: PeerHostErrorCode | null
}

export class PeerHostStoreError extends Error {
  readonly code: PeerHostErrorCode

  constructor(code: PeerHostErrorCode, message: string) {
    super(message)
    this.name = 'PeerHostStoreError'
    this.code = code
  }
}

/** 当前 Host 的 PeerHost 配置服务；所有 mutation 都在 Host 内完成校验。 */
export class PeerHostStore {
  private records: PeerHostRecord[] | null = null
  private operation: Promise<void> = Promise.resolve()

  constructor(
    private readonly ownerUserId: string,
    private readonly recordStore: PeerHostRecordStore,
    private readonly credentials: PeerHostCredentialStore,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => `peer-${randomBytes(12).toString('hex')}`,
  ) {
    if (!ownerUserId.trim()) throw new TypeError('PeerHost ownerUserId 不能为空')
  }

  async list(): Promise<readonly PeerHostRecord[]> {
    await this.load()
    return this.records!.map(cloneRecord)
  }

  async get(peerHostId: string): Promise<PeerHostRecord | null> {
    const record = (await this.list()).find((item) => item.id === peerHostId)
    return record ?? null
  }

  async create(input: PeerHostCreateInput): Promise<PeerHostRecord> {
    return this.enqueue(async () => {
      await this.load()
      const displayName = requireDisplayName(input.displayName)
      const route = normalizePeerHostRoute(input.route)
      this.assertUnique(route)
      const timestamp = this.now()
      const record: PeerHostRecord = {
        id: this.createId(),
        ownerUserId: this.ownerUserId,
        displayName,
        route,
        status: 'configured',
        pluginId: null,
        pluginVersion: null,
        dshVersion: null,
        hostname: null,
        configProfile: null,
        apiCompatibility: null,
        fingerprint: null,
        lastCheckedAt: null,
        lastErrorCode: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      this.records!.push(record)
      await this.persist()
      return cloneRecord(record)
    })
  }

  async update(peerHostId: string, input: PeerHostUpdateInput): Promise<PeerHostRecord> {
    return this.enqueue(async () => {
      await this.load()
      const index = this.findIndex(peerHostId)
      const previous = this.records![index]!
      const displayName = input.displayName === undefined ? previous.displayName : requireDisplayName(input.displayName)
      const route = input.route === undefined ? previous.route : normalizePeerHostRoute(input.route)
      const routeChanged = routeKey(previous.route) !== routeKey(route)
      if (routeChanged) this.assertUnique(route, peerHostId)
      const next: PeerHostRecord = {
        ...previous,
        displayName,
        route,
        ...(routeChanged ? resetHandshake(previous) : {}),
        updatedAt: this.now(),
      }
      this.records![index] = next
      if (routeChanged) await this.credentials.clear(peerHostId)
      await this.persist()
      return cloneRecord(next)
    })
  }

  async remove(peerHostId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.load()
      const index = this.findIndex(peerHostId)
      this.records!.splice(index, 1)
      await this.credentials.clear(peerHostId)
      await this.persist()
    })
  }

  async updateHandshake(peerHostId: string, input: PeerHostHandshakeUpdate): Promise<PeerHostRecord> {
    return this.enqueue(async () => {
      await this.load()
      const index = this.findIndex(peerHostId)
      const next: PeerHostRecord = { ...this.records![index]!, ...input, updatedAt: this.now() }
      this.records![index] = next
      await this.persist()
      return cloneRecord(next)
    })
  }

  async updateStatus(peerHostId: string, status: PeerHostRecord['status'], lastErrorCode: PeerHostErrorCode | null): Promise<PeerHostRecord> {
    return this.enqueue(async () => {
      await this.load()
      const index = this.findIndex(peerHostId)
      const next: PeerHostRecord = { ...this.records![index]!, status, lastErrorCode, updatedAt: this.now() }
      this.records![index] = next
      await this.persist()
      return cloneRecord(next)
    })
  }

  private async load(): Promise<void> {
    if (this.records !== null) return
    const records = await this.recordStore.read()
    this.records = records
      .filter((record) => record.ownerUserId === this.ownerUserId)
      .map((record) => ({ ...record, route: normalizePeerHostRoute(record.route) }))
  }

  private async persist(): Promise<void> {
    await this.recordStore.write(this.records!.map(cloneRecord))
  }

  private findIndex(peerHostId: string): number {
    const index = this.records!.findIndex((record) => record.id === peerHostId)
    if (index < 0) throw new PeerHostStoreError(PEER_HOST_ERROR_CODES.NOT_FOUND, 'PeerHost 不存在')
    return index
  }

  private assertUnique(route: PeerHostRoute, exceptId?: string): void {
    if (this.records!.some((record) => record.id !== exceptId && routeKey(record.route) === routeKey(route))) {
      throw new PeerHostStoreError(PEER_HOST_ERROR_CODES.DUPLICATE, 'PeerHost 路由已存在')
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation)
    this.operation = next.then(() => undefined, () => undefined)
    return next
  }
}

export class InMemoryPeerHostRecordStore implements PeerHostRecordStore {
  constructor(private records: readonly PeerHostRecord[] = []) {}

  async read(): Promise<readonly PeerHostRecord[]> {
    return this.records.map(cloneRecord)
  }

  async write(records: readonly PeerHostRecord[]): Promise<void> {
    this.records = records.map(cloneRecord)
  }
}

export class InMemoryPeerHostCredentialStore implements PeerHostCredentialStore {
  private readonly records = new Map<string, PeerHostTokenRecord>()

  async read(peerHostId: string): Promise<PeerHostTokenRecord | null> {
    const value = this.records.get(peerHostId)
    return value === undefined ? null : { ...value }
  }

  async write(peerHostId: string, credential: PeerHostTokenRecord): Promise<void> {
    this.records.set(peerHostId, { ...credential })
  }

  async clear(peerHostId: string): Promise<void> {
    this.records.delete(peerHostId)
  }
}

/** 非敏感记录的原子文件存储；token 不允许进入此文件。 */
export class FilePeerHostRecordStore implements PeerHostRecordStore {
  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new TypeError('PeerHost record 文件路径不能为空')
  }

  async read(): Promise<readonly PeerHostRecord[]> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!Array.isArray(value)) throw new Error('PeerHost record 文件格式无效')
      return value as PeerHostRecord[]
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return []
      throw error
    }
  }

  async write(records: readonly PeerHostRecord[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(records)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }
}

/** AES-256-GCM 文件存储，密钥必须由 Host 启动边界注入。 */
export class EncryptedFilePeerHostCredentialStore implements PeerHostCredentialStore {
  constructor(private readonly filePath: string, key: Uint8Array) {
    if (!filePath.trim()) throw new TypeError('PeerHost credential 文件路径不能为空')
    if (key.byteLength !== 32) throw new TypeError('PeerHost credential 密钥必须为 32 字节')
    this.key = Buffer.from(key)
  }

  private readonly key: Buffer

  async read(peerHostId: string): Promise<PeerHostTokenRecord | null> {
    const records = await this.readAll()
    const record = records[peerHostId]
    return record === undefined ? null : { ...record }
  }

  async write(peerHostId: string, credential: PeerHostTokenRecord): Promise<void> {
    const records = await this.readAll()
    records[peerHostId] = { ...credential }
    await this.writeAll(records)
  }

  async clear(peerHostId: string): Promise<void> {
    const records = await this.readAll()
    delete records[peerHostId]
    await this.writeAll(records)
  }

  private async readAll(): Promise<Record<string, PeerHostTokenRecord>> {
    try {
      const envelope = JSON.parse(await readFile(this.filePath, 'utf8')) as { iv?: string; tag?: string; data?: string }
      if (!envelope.iv || !envelope.tag || !envelope.data) throw new Error('PeerHost credential 文件格式无效')
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')
      const value: unknown = JSON.parse(plaintext)
      if (!isCredentialMap(value)) throw new Error('PeerHost credential 内容无效')
      return value
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return {}
      throw error
    }
  }

  private async writeAll(records: Record<string, PeerHostTokenRecord>): Promise<void> {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(records), 'utf8'), cipher.final()])
    const envelope = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64'),
    }
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }
}

export function normalizePeerHostRoute(route: PeerHostRoute): PeerHostRoute {
  if (route.kind === 'relay') {
    const deviceId = requireText(route.deviceId, 'deviceId')
    const relayEntryId = requireText(route.relayEntryId, 'relayEntryId')
    return { kind: 'relay', deviceId, relayEntryId, transportVersion: requireText(route.transportVersion, 'transportVersion') }
  }
  if (route.kind !== 'lan') throw new PeerHostStoreError(PEER_HOST_ERROR_CODES.INVALID_ROUTE, 'PeerHost 路由类型无效')
  const raw = requireText(route.baseUrl, 'baseUrl')
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new PeerHostStoreError(PEER_HOST_ERROR_CODES.INVALID_ROUTE, 'PeerHost 局域网地址无效')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new PeerHostStoreError(PEER_HOST_ERROR_CODES.INVALID_ROUTE, 'PeerHost 局域网地址必须是无凭据的 HTTP(S) Origin')
  }
  const normalizedOrigin = parsed.origin.toLowerCase()
  return { kind: 'lan', baseUrl: normalizedOrigin, normalizedOrigin }
}

function routeKey(route: PeerHostRoute): string {
  return route.kind === 'lan'
    ? `lan:${route.normalizedOrigin}`
    : `relay:${route.deviceId}:${route.relayEntryId}`
}

function resetHandshake(record: PeerHostRecord): Pick<PeerHostRecord, 'status' | 'pluginId' | 'pluginVersion' | 'dshVersion' | 'hostname' | 'configProfile' | 'apiCompatibility' | 'fingerprint' | 'lastCheckedAt' | 'lastErrorCode'> {
  return {
    status: 'configured',
    pluginId: null,
    pluginVersion: null,
    dshVersion: null,
    hostname: null,
    configProfile: null,
    apiCompatibility: null,
    fingerprint: null,
    lastCheckedAt: null,
    lastErrorCode: null,
  }
}

function requireDisplayName(value: string): string {
  const name = requireText(value, 'displayName')
  if (name.length > 128) throw new TypeError('PeerHost 名称不能超过 128 个字符')
  return name
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new PeerHostStoreError(PEER_HOST_ERROR_CODES.INVALID_ROUTE, `PeerHost ${field} 不能为空`)
  return value.trim()
}

function cloneRecord(record: PeerHostRecord): PeerHostRecord {
  return { ...record, route: record.route.kind === 'lan' ? { ...record.route } : { ...record.route } }
}

function isCredentialMap(value: unknown): value is Record<string, PeerHostTokenRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === 'object' && item !== null && typeof (item as PeerHostTokenRecord).accessToken === 'string' && typeof (item as PeerHostTokenRecord).refreshToken === 'string' && typeof (item as PeerHostTokenRecord).expiresAt === 'number')
}

function isNodeError(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === code
}
