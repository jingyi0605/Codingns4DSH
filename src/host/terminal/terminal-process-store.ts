import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TerminalLaunchProfile, TerminalProcessInstance } from '../../shared/contracts/terminal-process.js'

const STORE_VERSION = 1

interface TerminalProcessDocument {
  readonly version: typeof STORE_VERSION
  readonly profiles: readonly TerminalLaunchProfile[]
  readonly instances: readonly TerminalProcessInstance[]
}

export interface TerminalProcessStorePersistence {
  load(): Promise<unknown>
  save(document: TerminalProcessDocument): Promise<void>
}

export class JsonFileTerminalProcessStorePersistence implements TerminalProcessStorePersistence {
  constructor(private readonly filename: string) {}

  async load(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.filename, 'utf8')) as unknown
    } catch (error) {
      if (isMissingFile(error)) return { version: STORE_VERSION, profiles: [], instances: [] }
      throw error
    }
  }

  async save(document: TerminalProcessDocument): Promise<void> {
    const directory = dirname(this.filename)
    const temporary = `${this.filename}.${process.pid}.tmp`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filename)
  }
}

export class InMemoryTerminalProcessStorePersistence implements TerminalProcessStorePersistence {
  private document: unknown

  constructor(initial: unknown = { version: STORE_VERSION, profiles: [], instances: [] }) {
    this.document = structuredClone(initial)
  }

  async load(): Promise<unknown> { return structuredClone(this.document) }
  async save(document: TerminalProcessDocument): Promise<void> { this.document = structuredClone(document) }
}

export class TerminalProcessStore {
  private profiles = new Map<string, TerminalLaunchProfile>()
  private instances = new Map<string, TerminalProcessInstance>()
  private writeTail = Promise.resolve()
  private loaded = false

  constructor(private readonly persistence: TerminalProcessStorePersistence) {}

  async load(): Promise<void> {
    if (this.loaded) return
    const document = parseDocument(await this.persistence.load())
    this.profiles = new Map(document.profiles.map((profile) => [profileKey(profile), cloneProfile(profile)]))
    this.instances = new Map(document.instances.map((instance) => [instanceKey(instance), cloneInstance(instance)]))
    this.loaded = true
  }

  getProfile(workspaceId: string, profileId: string): TerminalLaunchProfile | undefined {
    this.requireLoaded()
    const profile = this.profiles.get(JSON.stringify([workspaceId, profileId]))
    return profile === undefined ? undefined : cloneProfile(profile)
  }

  listProfiles(workspaceId?: string): readonly TerminalLaunchProfile[] {
    this.requireLoaded()
    return [...this.profiles.values()]
      .filter((profile) => workspaceId === undefined || profile.workspaceId === workspaceId)
      .map(cloneProfile)
  }

  putProfile(profile: TerminalLaunchProfile): Promise<void> {
    this.requireLoaded()
    return this.enqueue(async () => {
      this.profiles.set(profileKey(profile), cloneProfile(profile))
      await this.persist()
    })
  }

  deleteProfile(workspaceId: string, profileId: string): Promise<boolean> {
    this.requireLoaded()
    return this.enqueue(async () => {
      const deleted = this.profiles.delete(JSON.stringify([workspaceId, profileId]))
      if (deleted) await this.persist()
      return deleted
    })
  }

  getInstance(instanceId: string): TerminalProcessInstance | undefined {
    this.requireLoaded()
    const instance = this.instances.get(instanceId)
    return instance === undefined ? undefined : cloneInstance(instance)
  }

  listInstances(workspaceId?: string): readonly TerminalProcessInstance[] {
    this.requireLoaded()
    return [...this.instances.values()]
      .filter((instance) => workspaceId === undefined || instance.workspaceId === workspaceId)
      .sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''))
      .map(cloneInstance)
  }

  putInstance(instance: TerminalProcessInstance): Promise<void> {
    this.requireLoaded()
    return this.enqueue(async () => {
      this.instances.set(instance.id, cloneInstance(instance))
      await this.persist()
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writeTail.then(operation, operation)
    this.writeTail = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async persist(): Promise<void> {
    await this.persistence.save({
      version: STORE_VERSION,
      profiles: [...this.profiles.values()],
      instances: [...this.instances.values()],
    })
  }

  private requireLoaded(): void {
    if (!this.loaded) throw new Error('终端进程存储尚未加载')
  }
}

function parseDocument(value: unknown): TerminalProcessDocument {
  if (!isRecord(value) || value.version !== STORE_VERSION || !Array.isArray(value.profiles) || !Array.isArray(value.instances)) {
    throw new TypeError('终端进程存储格式无效')
  }
  return {
    version: STORE_VERSION,
    profiles: value.profiles.map(parseProfile),
    instances: value.instances.map(parseInstance),
  }
}

function parseProfile(value: unknown): TerminalLaunchProfile {
  if (!isRecord(value)) throw new TypeError('终端启动项必须是对象')
  const profile = value as unknown as TerminalLaunchProfile
  validateProfile(profile)
  return cloneProfile(profile)
}

function parseInstance(value: unknown): TerminalProcessInstance {
  if (!isRecord(value)) throw new TypeError('终端进程实例必须是对象')
  const instance = value as unknown as TerminalProcessInstance
  validateInstance(instance)
  return cloneInstance(instance)
}

export function validateProfile(profile: TerminalLaunchProfile): void {
  for (const [name, value] of [['id', profile.id], ['workspaceId', profile.workspaceId], ['name', profile.name], ['command', profile.command], ['createdAt', profile.createdAt], ['updatedAt', profile.updatedAt]] as const) {
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`终端启动项字段 ${name} 无效`)
  }
  if (!isRelativePath(profile.cwdRelative)) throw new TypeError('终端启动项 cwdRelative 必须是 Workspace 内相对路径')
  if (!Array.isArray(profile.args) || profile.args.some((value) => typeof value !== 'string')) throw new TypeError('终端启动项 args 无效')
  if (!isRecord(profile.env) || Object.entries(profile.env).some(([key, value]) => key.trim() === '' || typeof value !== 'string')) throw new TypeError('终端启动项 env 无效')
  if (Object.keys(profile.env).some(isSecretEnvironmentName)) throw new TypeError('终端启动项不能持久化 TOKEN、SECRET、PASSWORD 或 KEY 环境变量')
  if (profile.runtimeMode !== 'pty') throw new TypeError('当前终端启动器只支持 runtimeMode=pty')
  if (!Number.isSafeInteger(profile.revision) || profile.revision < 1) throw new TypeError('终端启动项 revision 无效')
}

function validateInstance(instance: TerminalProcessInstance): void {
  for (const [name, value] of [['id', instance.id], ['workspaceId', instance.workspaceId], ['profileId', instance.profileId], ['terminalId', instance.terminalId]] as const) {
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`终端进程实例字段 ${name} 无效`)
  }
  if (!['starting', 'running', 'stopping', 'exited', 'failed', 'lost'].includes(instance.state)) throw new TypeError('终端进程实例 state 无效')
  if (instance.pid !== null && (!Number.isSafeInteger(instance.pid) || instance.pid < 1)) throw new TypeError('终端进程实例 pid 无效')
  if (instance.runtimeSessionKey !== null && typeof instance.runtimeSessionKey !== 'string') throw new TypeError('终端进程实例 runtimeSessionKey 无效')
  if (!isRecord(instance.resolvedCommand) || typeof instance.resolvedCommand.command !== 'string' || !Array.isArray(instance.resolvedCommand.args) || typeof instance.resolvedCommand.cwd !== 'string') throw new TypeError('终端进程实例 resolvedCommand 无效')
}

function cloneProfile(profile: TerminalLaunchProfile): TerminalLaunchProfile {
  return { ...profile, args: [...profile.args], env: { ...profile.env }, shell: { ...profile.shell, args: [...profile.shell.args] } }
}

function cloneInstance(instance: TerminalProcessInstance): TerminalProcessInstance {
  return { ...instance, resolvedCommand: { ...instance.resolvedCommand, args: [...instance.resolvedCommand.args] } }
}

function profileKey(profile: TerminalLaunchProfile): string { return JSON.stringify([profile.workspaceId, profile.id]) }
function instanceKey(instance: TerminalProcessInstance): string { return instance.id }
function isRelativePath(value: string): boolean { return value === '.' || (value.trim() !== '' && !value.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(value) && value !== '..' && !value.startsWith('../') && !value.includes('/../') && !value.includes('\\..')) }
function isSecretEnvironmentName(value: string): boolean { return /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/iu.test(value) }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isMissingFile(error: unknown): boolean { return isRecord(error) && error.code === 'ENOENT' }
