import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  PersistentTerminalRecord,
  TerminalOwnerScope,
  TerminalRecordIdentity,
} from '../../shared/contracts/terminal.js'

const STORE_VERSION = 1

interface TerminalStoreDocument {
  readonly version: typeof STORE_VERSION
  readonly records: readonly PersistentTerminalRecord[]
}

export interface TerminalStorePersistence {
  load(): Promise<unknown>
  save(document: TerminalStoreDocument): Promise<void>
}

/** JSON 文件写入采用同目录临时文件加 rename，避免崩溃留下半截记录。 */
export class JsonFileTerminalStorePersistence implements TerminalStorePersistence {
  constructor(private readonly filename: string) {}

  async load(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.filename, 'utf8')) as unknown
    } catch (error) {
      if (isMissingFile(error)) return { version: STORE_VERSION, records: [] }
      throw error
    }
  }

  async save(document: TerminalStoreDocument): Promise<void> {
    const directory = dirname(this.filename)
    const temporary = `${this.filename}.${process.pid}.tmp`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filename)
  }
}

/**
 * 持久终端记录表。
 *
 * 所有修改在一条 promise 队列中执行；调用完成代表新状态已经落盘。这样 create、
 * recover 与 close 不会用最后写入者覆盖彼此的结果。
 */
export class CodingNsTerminalStore {
  private readonly records = new Map<string, PersistentTerminalRecord>()
  private writeTail = Promise.resolve()
  private loaded = false

  constructor(private readonly persistence: TerminalStorePersistence) {}

  async load(): Promise<void> {
    if (this.loaded) return
    const document = parseDocument(await this.persistence.load())
    this.records.clear()
    for (const record of document.records) this.records.set(recordKey(record), record)
    this.loaded = true
  }

  list(scope?: TerminalOwnerScope): readonly PersistentTerminalRecord[] {
    this.requireLoaded()
    const records = [...this.records.values()]
      .filter((record) => scope === undefined || sameScope(record, scope))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    return records.map(cloneRecord)
  }

  get(identity: TerminalRecordIdentity): PersistentTerminalRecord | undefined {
    this.requireLoaded()
    const record = this.records.get(recordKey(identity))
    return record === undefined ? undefined : cloneRecord(record)
  }

  put(record: PersistentTerminalRecord): Promise<void> {
    validateRecord(record)
    return this.enqueue(async () => {
      this.records.set(recordKey(record), cloneRecord(record))
      await this.persist()
    })
  }

  patch(
    identity: TerminalRecordIdentity,
    patch: Partial<Pick<PersistentTerminalRecord, 'state' | 'title' | 'cols' | 'rows' | 'exitCode' | 'error' | 'updatedAt'>>,
  ): Promise<PersistentTerminalRecord | undefined> {
    return this.enqueue(async () => {
      const key = recordKey(identity)
      const current = this.records.get(key)
      if (current === undefined) return undefined
      const next: PersistentTerminalRecord = {
        ...current,
        ...patch,
        ...(patch.error === undefined ? { error: current.error } : {}),
      }
      validateRecord(next)
      this.records.set(key, next)
      await this.persist()
      return cloneRecord(next)
    })
  }

  remove(identity: TerminalRecordIdentity): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.records.delete(recordKey(identity))) return false
      await this.persist()
      return true
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.requireLoaded()
    const pending = this.writeTail.then(operation, operation)
    this.writeTail = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async persist(): Promise<void> {
    await this.persistence.save({ version: STORE_VERSION, records: this.list() })
  }

  private requireLoaded(): void {
    if (!this.loaded) throw new Error('终端持久存储尚未加载')
  }
}

export class InMemoryTerminalStorePersistence implements TerminalStorePersistence {
  private document: unknown

  constructor(initial: unknown = { version: STORE_VERSION, records: [] }) {
    this.document = structuredClone(initial)
  }

  async load(): Promise<unknown> {
    return structuredClone(this.document)
  }

  async save(document: TerminalStoreDocument): Promise<void> {
    this.document = structuredClone(document)
  }

  snapshot(): unknown {
    return structuredClone(this.document)
  }
}

export function terminalStorePath(settingsDocumentPath: string): string {
  return `${dirname(settingsDocumentPath)}/dsh-codingns/terminals.json`
}

function parseDocument(value: unknown): TerminalStoreDocument {
  if (!isRecord(value) || value.version !== STORE_VERSION || !Array.isArray(value.records)) {
    throw new TypeError('终端持久存储格式无效')
  }
  const records = value.records.map(parseRecord)
  // 旧版本把 sessionId 放进主键；升级到工作区主键后，重复项保留最后更新的一条。
  const byKey = new Map<string, PersistentTerminalRecord>()
  for (const record of records) {
    const key = recordKey(record)
    const previous = byKey.get(key)
    if (previous === undefined || previous.updatedAt <= record.updatedAt) byKey.set(key, record)
  }
  return { version: STORE_VERSION, records: [...byKey.values()] }
}

function parseRecord(value: unknown): PersistentTerminalRecord {
  if (!isRecord(value)) throw new TypeError('终端记录必须是对象')
  const record = value as unknown as PersistentTerminalRecord
  validateRecord(record)
  return cloneRecord(record)
}

function validateRecord(record: PersistentTerminalRecord): void {
  for (const [name, value] of [
    ['hostId', record.hostId],
    ['workspaceId', record.workspaceId],
    ['terminalId', record.terminalId],
    ['runtimeSessionKey', record.runtimeSessionKey],
    ['shellPath', record.shellPath],
    ['cwd', record.cwd],
    ['title', record.title],
    ['createdAt', record.createdAt],
    ['updatedAt', record.updatedAt],
  ] as const) {
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`终端记录字段 ${name} 无效`)
  }
  if (record.dshSessionId !== undefined && (typeof record.dshSessionId !== 'string' || record.dshSessionId.trim() === '')) {
    throw new TypeError('终端记录字段 dshSessionId 无效')
  }
  if (!['local-pty', 'tmux', 'conpty-powershell', 'conpty-cmd', 'conpty-git-bash'].includes(record.runtimeType)) {
    throw new TypeError('终端记录 runtimeType 无效')
  }
  if (!['starting', 'running', 'exited', 'closing', 'lost', 'closed', 'error'].includes(record.state)) {
    throw new TypeError('终端记录 state 无效')
  }
  if (!Number.isSafeInteger(record.cols) || record.cols < 2 || !Number.isSafeInteger(record.rows) || record.rows < 1) {
    throw new TypeError('终端记录尺寸无效')
  }
  if (record.exitCode !== null && !Number.isSafeInteger(record.exitCode)) throw new TypeError('终端记录 exitCode 无效')
  if (record.error !== undefined && typeof record.error !== 'string') throw new TypeError('终端记录 error 无效')
  if (record.shellProfileId !== undefined && !['zsh', 'bash', 'powershell', 'cmd', 'git-bash'].includes(record.shellProfileId)) {
    throw new TypeError('终端记录 shellProfileId 无效')
  }
  if (record.shellName !== undefined && (typeof record.shellName !== 'string' || record.shellName.trim() === '')) {
    throw new TypeError('终端记录 shellName 无效')
  }
  if (record.shellArgs !== undefined && (!Array.isArray(record.shellArgs) || record.shellArgs.some((value) => typeof value !== 'string'))) {
    throw new TypeError('终端记录 shellArgs 无效')
  }
  if (record.commandPath !== undefined && (typeof record.commandPath !== 'string' || record.commandPath.trim() === '')) {
    throw new TypeError('终端记录 commandPath 无效')
  }
  if (record.commandArgs !== undefined && (!Array.isArray(record.commandArgs) || record.commandArgs.some((value) => typeof value !== 'string'))) {
    throw new TypeError('终端记录 commandArgs 无效')
  }
  if (record.commandEnv !== undefined && (!isRecord(record.commandEnv) || Object.values(record.commandEnv).some((value) => typeof value !== 'string'))) {
    throw new TypeError('终端记录 commandEnv 无效')
  }
  if (record.launchProfileId !== undefined && (typeof record.launchProfileId !== 'string' || record.launchProfileId.trim() === '')) {
    throw new TypeError('终端记录 launchProfileId 无效')
  }
}

function sameScope(record: PersistentTerminalRecord, scope: TerminalOwnerScope): boolean {
  return record.hostId === scope.hostId
    && record.workspaceId === scope.workspaceId
}

function recordKey(identity: TerminalRecordIdentity): string {
  return JSON.stringify([identity.hostId, identity.workspaceId, identity.terminalId])
}

function cloneRecord(record: PersistentTerminalRecord): PersistentTerminalRecord {
  return {
    hostId: record.hostId,
    workspaceId: record.workspaceId,
    ...(record.dshSessionId === undefined ? {} : { dshSessionId: record.dshSessionId }),
    terminalId: record.terminalId,
    runtimeSessionKey: record.runtimeSessionKey,
    runtimeType: record.runtimeType,
    shellPath: record.shellPath,
    ...(record.shellProfileId === undefined ? {} : { shellProfileId: record.shellProfileId }),
    ...(record.shellName === undefined ? {} : { shellName: record.shellName }),
    ...(record.shellArgs === undefined ? {} : { shellArgs: [...record.shellArgs] }),
    ...(record.commandPath === undefined ? {} : { commandPath: record.commandPath }),
    ...(record.commandArgs === undefined ? {} : { commandArgs: [...record.commandArgs] }),
    ...(record.commandEnv === undefined ? {} : { commandEnv: { ...record.commandEnv } }),
    ...(record.launchProfileId === undefined ? {} : { launchProfileId: record.launchProfileId }),
    cwd: record.cwd,
    title: record.title,
    cols: record.cols,
    rows: record.rows,
    state: record.state,
    exitCode: record.exitCode,
    ...(record.error === undefined ? {} : { error: record.error }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}
