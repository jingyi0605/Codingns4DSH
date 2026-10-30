import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CredentialFieldSemanticMetadata } from '../../shared/contracts/credentials.js'

export interface HostCredentialRecord {
  readonly id: string
  readonly label: string
  readonly fields: Readonly<Record<string, string>>
  readonly fieldMetadata?: Readonly<Record<string, CredentialFieldSemanticMetadata>>
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: 1
}

export interface CredentialStore {
  read(): Promise<readonly HostCredentialRecord[]>
  write(records: readonly HostCredentialRecord[]): Promise<void>
}

export class InMemoryCredentialStore implements CredentialStore {
  private records: readonly HostCredentialRecord[]

  constructor(records: readonly HostCredentialRecord[] = []) {
    this.records = records.map(cloneRecord)
  }

  async read(): Promise<readonly HostCredentialRecord[]> {
    return this.records.map(cloneRecord)
  }

  async write(records: readonly HostCredentialRecord[]): Promise<void> {
    this.records = records.map(cloneRecord)
  }
}

export class EncryptedFileCredentialStore implements CredentialStore {
  private readonly key: Buffer | undefined
  private operation: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    key: Uint8Array | (() => Promise<Uint8Array>),
  ) {
    if (filePath.trim() === '') throw new TypeError('Credential store path is required')
    this.key = typeof key === 'function' ? undefined : validateKey(key)
    this.keySource = typeof key === 'function' ? key : undefined
  }

  private readonly keySource: (() => Promise<Uint8Array>) | undefined

  async read(): Promise<readonly HostCredentialRecord[]> {
    try {
      const envelope = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      return decryptRecords(envelope, await this.resolveKey())
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return []
      throw error
    }
  }

  async write(records: readonly HostCredentialRecord[]): Promise<void> {
    const next = this.operation.then(() => this.writeNow(records), () => this.writeNow(records))
    this.operation = next.then(() => undefined, () => undefined)
    return next
  }

  private async writeNow(records: readonly HostCredentialRecord[]): Promise<void> {
    const vaultKey = randomBytes(32)
    const wrappedKey = encryptValue(
      await this.resolveKey(),
      vaultKey,
      Buffer.from('codingns:credentials:v2:vault-key', 'utf8'),
    )
    const encryptedRecords = records.map((record) => ({
      id: record.id,
      label: record.label,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      version: record.version,
      ...(record.fieldMetadata === undefined ? {} : { fieldMetadata: record.fieldMetadata }),
      fields: Object.fromEntries(Object.entries(record.fields).map(([field, value]) => [
        field,
        encryptValue(vaultKey, Buffer.from(value, 'utf8'), fieldAad(record.id, field)),
      ])),
    }))
    const envelope = JSON.stringify({
      version: 2,
      key: wrappedKey,
      records: encryptedRecords,
    })
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${envelope}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, this.filePath)
    } finally {
      try {
        await unlink(temporary)
      } catch (error) {
        if (!isNodeError(error, 'ENOENT')) throw error
      }
    }
  }

  private async resolveKey(): Promise<Buffer> {
    if (this.key !== undefined) return this.key
    return validateKey(await this.keySource!())
  }
}

export function cloneRecord(record: HostCredentialRecord): HostCredentialRecord {
  return {
    ...record,
    fields: { ...record.fields },
    ...(record.fieldMetadata === undefined ? {} : { fieldMetadata: { ...record.fieldMetadata } }),
  }
}

function decryptRecords(value: unknown, key: Buffer): readonly HostCredentialRecord[] {
  if (!isRecord(value) || typeof value.version !== 'number') {
    throw new Error('Credential store envelope is invalid')
  }
  if (value.version === 1) return decryptLegacyRecords(value, key)
  if (value.version !== 2 || !isRecord(value.key) || !Array.isArray(value.records)) {
    throw new Error('Credential store envelope is invalid')
  }
  try {
    const vaultKey = decryptValue(key, value.key, Buffer.from('codingns:credentials:v2:vault-key', 'utf8'))
    if (vaultKey.byteLength !== 32) throw new Error('Credential vault key is invalid')
    return value.records.map((record) => parseEncryptedRecord(record, vaultKey))
  } catch {
    throw new Error('Credential store authentication failed')
  }
}

function parseRecord(value: unknown): HostCredentialRecord {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.label !== 'string'
    || !isStringMap(value.fields)
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || value.version !== 1) {
    throw new Error('Credential record is invalid')
  }
  return {
    id: value.id,
    label: value.label,
    fields: { ...value.fields },
    ...(isRecord(value.fieldMetadata) ? { fieldMetadata: cloneFieldMetadata(value.fieldMetadata) } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: 1,
  }
}

function decryptLegacyRecords(value: Record<string, unknown>, key: Buffer): readonly HostCredentialRecord[] {
  if (typeof value.iv !== 'string' || typeof value.tag !== 'string' || typeof value.data !== 'string') {
    throw new Error('Credential store envelope is invalid')
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, decodeBase64(value.iv))
    decipher.setAuthTag(decodeBase64(value.tag))
    const plaintext = Buffer.concat([
      decipher.update(decodeBase64(value.data)),
      decipher.final(),
    ]).toString('utf8')
    const records = JSON.parse(plaintext) as unknown
    if (!Array.isArray(records)) throw new Error('Credential store records are invalid')
    return records.map(parseRecord)
  } catch {
    throw new Error('Credential store authentication failed')
  }
}

function parseEncryptedRecord(value: unknown, vaultKey: Buffer): HostCredentialRecord {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.label !== 'string'
    || !isRecord(value.fields)
    || typeof value.createdAt !== 'string'
    || typeof value.updatedAt !== 'string'
    || value.version !== 1) {
    throw new Error('Credential record is invalid')
  }
  const fields: Record<string, string> = {}
  for (const [field, encrypted] of Object.entries(value.fields)) {
    fields[field] = decryptValue(vaultKey, encrypted, fieldAad(value.id, field)).toString('utf8')
  }
  return {
    id: value.id,
    label: value.label,
    fields,
    ...(isRecord(value.fieldMetadata) ? { fieldMetadata: cloneFieldMetadata(value.fieldMetadata) } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    version: 1,
  }
}

function cloneFieldMetadata(value: Record<string, unknown>): Readonly<Record<string, CredentialFieldSemanticMetadata>> {
  const result: Record<string, CredentialFieldSemanticMetadata> = {}
  for (const [field, metadata] of Object.entries(value)) {
    if (!isRecord(metadata)) continue
    const kind = typeof metadata.kind === 'string' ? metadata.kind : undefined
    const usages = Array.isArray(metadata.usages)
      ? metadata.usages.filter((usage): usage is string => typeof usage === 'string')
      : undefined
    result[field] = kind !== undefined && usages !== undefined
      ? { kind: kind as NonNullable<CredentialFieldSemanticMetadata['kind']>, usages: usages as NonNullable<CredentialFieldSemanticMetadata['usages']> }
      : kind !== undefined
        ? { kind: kind as NonNullable<CredentialFieldSemanticMetadata['kind']> }
        : usages !== undefined
          ? { usages: usages as NonNullable<CredentialFieldSemanticMetadata['usages']> }
          : {}
  }
  return result
}

interface CipherEnvelope {
  readonly iv: string
  readonly tag: string
  readonly data: string
}

function encryptValue(key: Buffer, plaintext: Uint8Array, aad: Uint8Array): CipherEnvelope {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  }
}

function decryptValue(key: Buffer, value: unknown, aad: Uint8Array): Buffer {
  if (!isRecord(value) || typeof value.iv !== 'string' || typeof value.tag !== 'string' || typeof value.data !== 'string') {
    throw new Error('Credential ciphertext is invalid')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, decodeBase64(value.iv))
  decipher.setAAD(aad)
  decipher.setAuthTag(decodeBase64(value.tag))
  return Buffer.concat([decipher.update(decodeBase64(value.data)), decipher.final()])
}

function fieldAad(recordId: string, field: string): Buffer {
  return Buffer.from(`codingns:credentials:v2:record:${recordId}:field:${field}`, 'utf8')
}

function decodeBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.byteLength === 0) throw new Error('Credential ciphertext is empty')
  return decoded
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.entries(value).every(([key, item]) => key !== '' && typeof item === 'string')
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): error is Error & { readonly code: string } {
  return error instanceof Error && 'code' in error && (error as { readonly code?: unknown }).code === code
}

function validateKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new TypeError('Credential store key must be 32 bytes')
  return Buffer.from(key)
}
