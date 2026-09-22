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
