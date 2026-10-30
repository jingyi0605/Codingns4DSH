import { homedir } from 'node:os'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import type {
  CredentialEnvironmentBinding,
  CredentialErrorCode,
  CredentialListPage,
  CredentialMetadata,
  CredentialMutation,
  CredentialReference,
} from '../../shared/contracts/credentials.js'
import { CREDENTIAL_ENV_PATTERN, defaultCredentialEnvironmentName } from '../../shared/contracts/credentials.js'
import { CodingNsRpcError } from '../rpc-table.js'
import {
  cloneRecord,
  EncryptedFileCredentialStore,
  type CredentialStore,
  type HostCredentialRecord,
} from './store.js'

const MAX_CREDENTIALS = 256
const MAX_FIELDS = 32
const MAX_ID_LENGTH = 128
const MAX_LABEL_LENGTH = 160
const MAX_FIELD_NAME_LENGTH = 80
const MAX_VALUE_LENGTH = 32 * 1024
const RESERVED_ENV_PREFIX = 'CODINGNS_'
const RESERVED_ENV_NAMES = new Set(['PATH', 'HOME', 'USERPROFILE', 'NODE_OPTIONS', 'PWD', 'SHELL'])
const DEFAULT_PAGE_SIZE = 32
const MAX_PAGE_SIZE = 64

export interface CredentialServiceOptions {
  readonly store?: CredentialStore
  readonly now?: () => Date
  readonly masterPasswordPath?: string
}

export class CredentialService {
  private readonly store: CredentialStore
  private readonly now: () => Date
  private readonly masterPasswordPath: string | undefined
  private records: Map<string, HostCredentialRecord> | undefined
  private operation: Promise<void> = Promise.resolve()
  private active = false

  constructor(options: CredentialServiceOptions = {}) {
    this.store = options.store ?? new EncryptedFileCredentialStore(defaultCredentialPath(), () => loadOrCreateCredentialKey(defaultCredentialKeyPath()))
    this.now = options.now ?? (() => new Date())
    this.masterPasswordPath = options.masterPasswordPath ?? (options.store === undefined ? defaultCredentialPasswordPath() : undefined)
  }

  async masterPasswordStatus(): Promise<{ readonly configured: boolean }> {
    if (this.masterPasswordPath === undefined) return { configured: false }
    return { configured: await readMasterPasswordRecord(this.masterPasswordPath) !== undefined }
  }

  async setMasterPassword(input: { readonly currentPassword?: string; readonly password: string }): Promise<void> {
    return this.enqueue(async () => {
      this.ensureActive()
      if (this.masterPasswordPath === undefined) throw credentialError('CREDENTIAL_MASTER_PASSWORD_INVALID', 'Master password storage is unavailable')
      const password = typeof input?.password === 'string' ? input.password : ''
      if (password.length < 8 || password.length > 256) {
        throw credentialError('CREDENTIAL_MASTER_PASSWORD_INVALID', 'Master password must contain 8 to 256 characters')
      }
      const existing = await readMasterPasswordRecord(this.masterPasswordPath)
      if (existing !== undefined) {
        const current = typeof input.currentPassword === 'string' ? input.currentPassword : ''
        if (!verifyMasterPassword(current, existing)) {
          throw credentialError('CREDENTIAL_MASTER_PASSWORD_INVALID', 'Current master password is invalid')
        }
      }
      await writeMasterPasswordRecord(this.masterPasswordPath, password)
    })
  }

  async list(): Promise<readonly CredentialMetadata[]> {
    return [...(await this.readRecords()).values()].map(toMetadata)
  }

  async listPage(options: { readonly query?: string; readonly cursor?: string; readonly limit?: number } = {}): Promise<CredentialListPage> {
    const query = options.query?.trim().toLocaleLowerCase() ?? ''
    const cursor = parseCursor(options.cursor)
    const limit = normalizePageSize(options.limit)
    const items = [...(await this.readRecords()).values()]
      .map(toMetadata)
      .filter((item) => query === '' || item.label.toLocaleLowerCase().includes(query) || item.id.toLocaleLowerCase().includes(query)
        || item.fields.some((field) => field.name.toLocaleLowerCase().includes(query)))
    const page = items.slice(cursor, cursor + limit)
    const nextCursor = cursor + page.length < items.length ? String(cursor + page.length) : undefined
    return { items: page, ...(nextCursor === undefined ? {} : { nextCursor }) }
  }

  async save(input: CredentialMutation): Promise<CredentialMetadata> {
    return this.enqueue(async () => {
      this.ensureActive()
      const records = await this.readRecords()
      const normalized = normalizeMutation(input)
      const previous = records.get(normalized.id)
      const fields: Record<string, string> = {}
      for (const [name, value] of Object.entries(normalized.fields)) {
        if (typeof value === 'string') fields[name] = value
        else if (isKeepExisting(value)) {
          const existing = previous?.fields[name]
          if (existing !== undefined) fields[name] = existing
        }
        else if (isClear(value)) {
          // Explicitly clearing a field omits it from the replacement record.
        }
      }
      if (previous !== undefined) {
        for (const [name, value] of Object.entries(previous.fields)) {
          if (!(name in normalized.fields)) fields[name] = value
        }
      }
      if (Object.keys(fields).length === 0) throw credentialError('CREDENTIAL_INVALID', 'At least one credential field is required')
      const timestamp = this.now().toISOString()
      const record: HostCredentialRecord = {
        id: normalized.id,
        label: normalized.label,
        fields,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
        version: 1,
      }
      if (previous === undefined && records.size >= MAX_CREDENTIALS) throw credentialError('CREDENTIAL_INVALID', 'Too many credentials')
      records.set(record.id, record)
      await this.store.write([...records.values()])
      this.records = records
      return toMetadata(record)
    })
  }

  async delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      this.ensureActive()
      const records = await this.readRecords()
      if (!records.delete(requireId(id))) throw credentialError('CREDENTIAL_NOT_FOUND', 'Credential not found')
      await this.store.write([...records.values()])
      this.records = records
    })
  }

  async resolve(reference: CredentialReference): Promise<Readonly<Record<string, string>>> {
    this.ensureActive()
    const records = await this.readRecords()
    const record = records.get(requireId(reference.credentialId))
    if (record === undefined) throw credentialError('CREDENTIAL_NOT_FOUND', 'Credential not found')
    if (!Array.isArray(reference.bindings) || reference.bindings.length === 0) throw credentialError('CREDENTIAL_INVALID', 'Credential bindings are required')
    const resolved: Record<string, string> = {}
    for (const binding of reference.bindings) {
      const field = requireFieldName(binding.field)
      const env = requireEnvironmentName(binding.env)
      if (resolved[env] !== undefined) throw credentialError('CREDENTIAL_ENV_CONFLICT', 'Credential environment names must be unique')
      const value = record.fields[field]
      if (value === undefined) throw credentialError('CREDENTIAL_FIELD_NOT_FOUND', 'Credential field not found')
      resolved[env] = value
    }
    return resolved
  }

  async resolveAll(credentialId: string): Promise<Readonly<Record<string, string>>> {
    const records = await this.readRecords()
    const record = records.get(requireId(credentialId))
    if (record === undefined) throw credentialError('CREDENTIAL_NOT_FOUND', 'Credential not found')
    const bindings = Object.keys(record.fields).map((field) => ({
      field,
      env: defaultCredentialEnvironmentName(field),
    }))
    return this.resolve({ credentialId: record.id, bindings })
  }

  activate(): void {
    this.active = true
  }

  deactivate(): void {
    this.active = false
    this.records = undefined
  }

  private async readRecords(): Promise<Map<string, HostCredentialRecord>> {
    this.ensureActive()
    if (this.records !== undefined) return new Map([...this.records.entries()].map(([id, record]) => [id, cloneRecord(record)]))
    try {
      const records = await this.store.read()
      const next = new Map<string, HostCredentialRecord>()
      for (const record of records) {
        const normalized = normalizeStoredRecord(record)
        if (next.has(normalized.id)) throw credentialError('CREDENTIAL_STORE_UNAVAILABLE', 'Credential store contains duplicate IDs')
        next.set(normalized.id, normalized)
      }
      this.records = next
      return new Map([...next.entries()].map(([id, record]) => [id, cloneRecord(record)]))
    } catch (error) {
      if (error instanceof CodingNsRpcError) throw error
      throw credentialError('CREDENTIAL_STORE_UNAVAILABLE', 'Credential store is unavailable')
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation)
    this.operation = next.then(() => undefined, () => undefined)
    return next
  }

  private ensureActive(): void {
    if (!this.active) throw credentialError('CREDENTIAL_STORE_UNAVAILABLE', 'Credential module is stopped')
  }
}

export function toMetadata(record: HostCredentialRecord): CredentialMetadata {
  return {
    id: record.id,
    label: record.label,
    fields: Object.keys(record.fields).sort().map((name) => ({ name, hasValue: record.fields[name] !== '' })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export function normalizeMutation(value: CredentialMutation): CredentialMutation {
  if (!isRecord(value)) throw credentialError('CREDENTIAL_INVALID', 'Credential mutation must be an object')
  const id = requireId(value.id)
  const label = typeof value.label === 'string' ? value.label.trim() : ''
  if (label === '' || label.length > MAX_LABEL_LENGTH) throw credentialError('CREDENTIAL_INVALID', 'Credential label is invalid')
  if (!isRecord(value.fields) || Object.keys(value.fields).length > MAX_FIELDS) throw credentialError('CREDENTIAL_INVALID', 'Credential fields are invalid')
  const fields: Record<string, CredentialMutation['fields'][string]> = {}
  for (const [name, raw] of Object.entries(value.fields)) {
    const field = requireFieldName(name)
    if (typeof raw === 'string') {
      if (raw.length === 0 || raw.length > MAX_VALUE_LENGTH) throw credentialError('CREDENTIAL_INVALID', 'Credential value is invalid')
      fields[field] = raw
    } else if (isKeepExisting(raw)) fields[field] = { keepExisting: true }
    else if (isClear(raw)) fields[field] = { clear: true }
    else throw credentialError('CREDENTIAL_INVALID', 'Credential field mutation is invalid')
  }
  return { id, label, fields }
}

function normalizeStoredRecord(record: HostCredentialRecord): HostCredentialRecord {
  if (!isRecord(record) || requireId(record.id) !== record.id || typeof record.label !== 'string' || !isRecord(record.fields)) {
    throw credentialError('CREDENTIAL_STORE_UNAVAILABLE', 'Credential store record is invalid')
  }
  const fields: Record<string, string> = {}
  for (const [name, value] of Object.entries(record.fields)) {
    requireFieldName(name)
    if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) throw credentialError('CREDENTIAL_STORE_UNAVAILABLE', 'Credential store field is invalid')
    fields[name] = value
  }
  if (Object.keys(fields).length === 0) throw credentialError('CREDENTIAL_STORE_UNAVAILABLE', 'Credential store record has no fields')
  return {
    id: record.id,
    label: record.label,
    fields,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: 1,
  }
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value.trim())) {
    throw credentialError('CREDENTIAL_INVALID', 'Credential ID is invalid')
  }
  return value.trim()
}

function requireFieldName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(value.trim())) {
    throw credentialError('CREDENTIAL_INVALID', 'Credential field name is invalid')
  }
  return value.trim()
}

function requireEnvironmentName(value: unknown): string {
  if (typeof value !== 'string' || !CREDENTIAL_ENV_PATTERN.test(value) || RESERVED_ENV_NAMES.has(value) || value.startsWith(RESERVED_ENV_PREFIX)) {
    throw credentialError('CREDENTIAL_ENV_INVALID', 'Credential environment name is invalid')
  }
  return value
}

function credentialError(code: CredentialErrorCode, message: string): CodingNsRpcError {
  return new CodingNsRpcError(code, message)
}

function parseCursor(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0
  const cursor = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw credentialError('CREDENTIAL_INVALID', 'Credential list cursor is invalid')
  return cursor
}

function normalizePageSize(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw credentialError('CREDENTIAL_INVALID', 'Credential list page size is invalid')
  }
  return value
}

function defaultCredentialPath(): string {
  const directory = process.env.CODINGNS4DSH_STATE_DIR?.trim() || join(homedir(), '.config', 'codingns4dsh')
  return join(directory, 'credentials.enc')
}

function defaultCredentialKeyPath(): string {
  const directory = process.env.CODINGNS4DSH_STATE_DIR?.trim() || join(homedir(), '.config', 'codingns4dsh')
  return join(directory, 'credentials.key')
}

function defaultCredentialPasswordPath(): string {
  const directory = process.env.CODINGNS4DSH_STATE_DIR?.trim() || join(homedir(), '.config', 'codingns4dsh')
  return join(directory, 'credentials.password')
}

interface MasterPasswordRecord {
  readonly version: 1
  readonly salt: string
  readonly hash: string
}

async function readMasterPasswordRecord(path: string): Promise<MasterPasswordRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isRecord(value) || value.version !== 1 || typeof value.salt !== 'string' || typeof value.hash !== 'string') {
      throw new Error('Master password record is invalid')
    }
    return { version: 1, salt: value.salt, hash: value.hash }
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined
    throw error
  }
}

function verifyMasterPassword(password: string, record: MasterPasswordRecord): boolean {
  try {
    const expected = Buffer.from(record.hash, 'base64')
    const actual = scryptSync(password, Buffer.from(record.salt, 'base64'), expected.byteLength, { N: 16_384, r: 8, p: 1 })
    return expected.byteLength > 0 && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

async function writeMasterPasswordRecord(path: string, password: string): Promise<void> {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1 })
  const record = JSON.stringify({ version: 1, salt: salt.toString('base64'), hash: hash.toString('base64') })
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${record}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

async function loadOrCreateCredentialKey(path: string): Promise<Uint8Array> {
  try {
    const key = await readFile(path)
    if (key.byteLength !== 32) throw new Error('Credential key file is invalid')
    return key
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error
    const key = randomBytes(32)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try {
      await writeFile(path, key, { mode: 0o600, flag: 'wx' })
      return key
    } catch (writeError) {
      if (!isNodeError(writeError, 'EEXIST')) throw writeError
      const existing = await readFile(path)
      if (existing.byteLength !== 32) throw new Error('Credential key file is invalid')
      return existing
    }
  }
}

function isNodeError(error: unknown, code: string): error is Error & { readonly code: string } {
  return error instanceof Error && 'code' in error && (error as { readonly code?: unknown }).code === code
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isKeepExisting(value: unknown): value is { readonly keepExisting: true } {
  return isRecord(value) && value.keepExisting === true
}

function isClear(value: unknown): value is { readonly clear: true } {
  return isRecord(value) && value.clear === true
}
