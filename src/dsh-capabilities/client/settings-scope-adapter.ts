import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CodingNsSettings } from '../../shared/contracts/config.js'
import { accepted, type CodingNsSettingsOperation, type CodingNsSettingsSnapshot, type CodingNsSettingsStore } from '../settings-store.js'

/** 旧版 Client SettingsScope 到 CodingNS 内部设置接口的适配器。 */
export function createLegacyClientSettingsStore(scope: SettingsScope<CodingNsSettings>): CodingNsSettingsStore<CodingNsSettings> {
  const store: CodingNsSettingsStore<CodingNsSettings> = {
    getSnapshot: () => {
      const snapshot = scope.getSnapshot()
      return { value: snapshot.value, revision: snapshot.revision, writable: snapshot.writable, status: snapshot.status }
    },
    subscribe: (listener) => scope.subscribe(listener),
    mutate: (operations, revision) => accepted(scope.mutate(operations as Parameters<typeof scope.mutate>[0], revision)),
    set: (field, value) => accepted(scope.set(field, value)),
    unset: (field) => accepted(scope.unset(field)),
  }
  return store
}

export type CodingNsClientSettingsStore = CodingNsSettingsStore<CodingNsSettings>
export type { CodingNsSettingsOperation, CodingNsSettingsSnapshot }
