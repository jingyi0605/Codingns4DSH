import type { CodingNsSettings } from '../../shared/contracts/config.js'
import type { CodingNsSettingsOperation, CodingNsSettingsStore } from '../settings-store.js'

/** 0.1.7 Config/SettingsForms 的最小结构化边界，避免业务代码绑定 DSH 类型包。 */
export interface DshHostConfigSettings {
  describe(options?: { readonly redactSecrets?: boolean }): readonly DshSettingsDescriptor[]
  mutate(namespace: string, operations: readonly CodingNsSettingsOperation[], expectedRevision?: number): Promise<void>
  on?(event: 'settings/document-updated', listener: (namespace: string, revision: number) => void): () => void
}

export interface DshSettingsDescriptor {
  readonly ns: string
  readonly value: unknown
  readonly revision: number
  readonly writable?: boolean
}

/** 0.1.7 Host Config 路由适配器。 */
export function createConfigSettingsStore(
  settings: DshHostConfigSettings,
  namespace: string,
): CodingNsSettingsStore<CodingNsSettings> {
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  const unsubscribeHost = settings.on?.('settings/document-updated', (updatedNamespace) => {
    if (updatedNamespace === namespace) notify()
  })
  const snapshot = (): { value: CodingNsSettings | undefined; revision: number | undefined; writable: boolean; status: 'loading' | 'ready' | 'unavailable' } => {
    const descriptor = settings.describe({ redactSecrets: true }).find((item) => item.ns === namespace)
    if (descriptor === undefined) return { value: undefined, revision: undefined, writable: false, status: 'unavailable' }
    return { value: descriptor.value as CodingNsSettings, revision: descriptor.revision, writable: descriptor.writable !== false, status: 'ready' }
  }
  return {
    getSnapshot: snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    mutate: async (operations, expectedRevision) => {
      await settings.mutate(namespace, operations, expectedRevision)
      notify()
      return true
    },
    set: async (field, value) => {
      await settings.mutate(namespace, [{ op: 'set', path: [field], value }])
      notify()
      return true
    },
    unset: async (field) => {
      await settings.mutate(namespace, [{ op: 'unset', path: [field] }])
      notify()
      return true
    },
    dispose: () => { unsubscribeHost?.(); listeners.clear() },
  }
}
