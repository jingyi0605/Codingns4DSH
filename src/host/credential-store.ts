import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DshDeviceCredentialRecord } from '../shared/contracts/dsh-device.js'

/** 仅 Host 内部使用的敏感凭据；不要从 Client entry 导入或序列化到客户端。 */
export interface HostCredentialRecord {
  controlBaseUrl: string
  accountId: string
  refreshToken: string
  refreshTokenExpiresAt: string
  deviceId: string | null
  savedAt: string
}

/** Host 凭据存储抽象；生产实现应接入 DSH/CodingNS 的安全凭据存储。 */
export interface CodingNsCredentialStore {
  read(): Promise<HostCredentialRecord | null>
  write(record: HostCredentialRecord): Promise<void>
  clear(): Promise<void>
}

/**
 * 测试用内存实现。
 * 不提供持久化或加密语义，不能用于生产；用于阶段 2 状态机单元测试。
 */
export class InMemoryCodingNsCredentialStore implements CodingNsCredentialStore {
  private record: HostCredentialRecord | null = null

  async read(): Promise<HostCredentialRecord | null> {
    return this.record ? { ...this.record } : null
  }

  async write(record: HostCredentialRecord): Promise<void> {
    this.record = { ...record }
  }

  async clear(): Promise<void> {
    this.record = null
  }
}

/** Host 侧 refresh token 的文件存储；文件权限限制为当前用户可读写。 */
export class FileCodingNsCredentialStore implements CodingNsCredentialStore {
  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new TypeError('CodingNS credential file path 不能为空')
  }

  async read(): Promise<HostCredentialRecord | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      return parseHostCredential(value)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  async write(record: HostCredentialRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }

  async clear(): Promise<void> {
    try {
      const { unlink } = await import('node:fs/promises')
      await unlink(this.filePath)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
}

/** DSH device credential 独立存储，避免与 CodingNS refresh token 混用。 */
export interface DshDeviceCredentialStore {
  read(): Promise<DshDeviceCredentialRecord | null>
  write(record: DshDeviceCredentialRecord): Promise<void>
  clear(): Promise<void>
}

export class InMemoryDshDeviceCredentialStore implements DshDeviceCredentialStore {
  private record: DshDeviceCredentialRecord | null = null
  async read(): Promise<DshDeviceCredentialRecord | null> { return this.record ? { ...this.record } : null }
  async write(record: DshDeviceCredentialRecord): Promise<void> { this.record = { ...record } }
  async clear(): Promise<void> { this.record = null }
}

export class FileDshDeviceCredentialStore implements DshDeviceCredentialStore {
  constructor(private readonly filePath: string) {
    if (!filePath.trim()) throw new TypeError('DSH device credential file path 不能为空')
  }

  async read(): Promise<DshDeviceCredentialRecord | null> {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      return parseDshCredential(value)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  async write(record: DshDeviceCredentialRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
  }

  async clear(): Promise<void> {
    try {
      const { unlink } = await import('node:fs/promises')
      await unlink(this.filePath)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
}

function parseHostCredential(value: unknown): HostCredentialRecord {
  if (!isRecord(value) || typeof value.controlBaseUrl !== 'string' || typeof value.accountId !== 'string' || typeof value.refreshToken !== 'string' || typeof value.refreshTokenExpiresAt !== 'string' || (typeof value.deviceId !== 'string' && value.deviceId !== null) || typeof value.savedAt !== 'string') {
    throw new Error('CodingNS credential 文件格式无效')
  }
  return { controlBaseUrl: value.controlBaseUrl, accountId: value.accountId, refreshToken: value.refreshToken, refreshTokenExpiresAt: value.refreshTokenExpiresAt, deviceId: value.deviceId, savedAt: value.savedAt }
}

function parseDshCredential(value: unknown): DshDeviceCredentialRecord {
  if (!isRecord(value) || typeof value.deviceId !== 'string' || typeof value.deviceCredential !== 'string' || typeof value.credentialVersion !== 'number' || !Number.isInteger(value.credentialVersion) || value.credentialVersion < 1 || typeof value.dtlsFingerprint !== 'string' || (typeof value.tunnelDomain !== 'string' && value.tunnelDomain !== null) || typeof value.displayName !== 'string' || typeof value.savedAt !== 'string') {
    throw new Error('DSH device credential 文件格式无效')
  }
  return { deviceId: value.deviceId, deviceCredential: value.deviceCredential, credentialVersion: value.credentialVersion, dtlsFingerprint: value.dtlsFingerprint, tunnelDomain: value.tunnelDomain, displayName: value.displayName, savedAt: value.savedAt }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === code
}
