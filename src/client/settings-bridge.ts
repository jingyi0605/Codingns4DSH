import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsSettings } from '../shared/contracts/config.js'
import type { CodingNsRpcClient } from './features/types.js'

type SettingsMutation = Parameters<SettingsScope<CodingNsSettings>['mutate']>[0]
type SnapshotListener = () => void

interface RemoteSettingsResponse {
  readonly value: CodingNsSettings
  readonly revision: number
}

/**
 * 把 DSH 本地设置和远程 Host 设置 RPC 统一成一个设置作用域。
 * 非回环页面使用 RPC，回环页面完全复用 DSH 的原生设置传输。
 */
export class CodingNsSettingsBridge implements SettingsScope<CodingNsSettings> {
  private snapshot: SettingsScopeSnapshot<CodingNsSettings>
  private readonly listeners = new Set<SnapshotListener>()
  private readonly localUnsubscribe: () => void
  private remoteLoad: Promise<void> | undefined
  private remoteLoaded = false

  constructor(
    private readonly local: SettingsScope<CodingNsSettings>,
    private readonly rpc: CodingNsRpcClient,
  ) {
    this.snapshot = local.getSnapshot()
    this.localUnsubscribe = local.subscribe(() => {
      if (this.isRemote()) {
        void this.load().catch(() => undefined)
        return
      }
      this.remoteLoaded = false
      this.publish(local.getSnapshot())
    })
  }

  getSnapshot(): SettingsScopeSnapshot<CodingNsSettings> { return this.snapshot }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async load(): Promise<void> {
    if (!this.isRemote()) return
    if (this.remoteLoaded) return
    if (this.remoteLoad !== undefined) return this.remoteLoad
    this.remoteLoad = this.call<RemoteSettingsResponse>('settings/get', {}).then((response) => {
      this.remoteLoaded = true
      this.publish({
        status: 'ready',
        value: response.value,
        base: undefined,
        user: undefined,
        revision: response.revision,
        writable: true,
        mode: 'host',
      })
    }).finally(() => {
      this.remoteLoad = undefined
    })
    return this.remoteLoad
  }

  async set(field: string, value: unknown): Promise<void> {
    if (!this.isRemote()) return this.local.set(field, value)
    return this.mutate([{ op: 'set', path: [field], value }])
  }

  async unset(field: string): Promise<void> {
    if (!this.isRemote()) return this.local.unset(field)
    return this.mutate([{ op: 'unset', path: [field] }])
  }

  async mutate(ops: SettingsMutation, expectedRevision?: number): Promise<void> {
    if (!this.isRemote()) return this.local.mutate(ops, expectedRevision)
    const payload = expectedRevision === undefined ? { ops } : { ops, expectedRevision }
    const response = await this.call<RemoteSettingsResponse>('settings/set', payload)
    this.remoteLoaded = true
    this.publish({
      ...this.snapshot,
      status: 'ready',
      value: response.value,
      revision: response.revision,
      writable: true,
      mode: 'host',
    })
  }

  dispose(): void { this.localUnsubscribe() }

  private async call<T>(endpoint: string, payload: unknown): Promise<T> {
    let result
    try {
      result = await this.rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload)
    } catch (error) {
      // DSH 原生连接通常把自定义 RPC 映射到 /api；保留逻辑通道兼容
      // CodingNS Transport，同时在普通 Web Host 上回退到实际 Fetch 路由。
      const message = error instanceof Error ? error.message : String(error)
      if (!/HTTP (?:404|405)\b/u.test(message)) throw error
      result = await this.rpc.call('/api', `codingns/${endpoint}`, payload)
    }
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }

  private publish(next: SettingsScopeSnapshot<CodingNsSettings>): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  private isRemote(): boolean {
    const snapshot = this.local.getSnapshot()
    return snapshot.mode === 'memory' || snapshot.status === 'unavailable'
  }
}

export function createCodingNsSettingsBridge(
  local: SettingsScope<CodingNsSettings>,
  rpc: CodingNsRpcClient,
): CodingNsSettingsBridge {
  return new CodingNsSettingsBridge(local, rpc)
}
