import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { CodingNsSettings } from '../../shared/contracts/config.js'
import type {
  CodingNsSettingsOperation,
  CodingNsSettingsSnapshot,
  CodingNsSettingsStore,
} from '../settings-store.js'

/** 旧版 Host SettingsScope 到 CodingNS 内部设置接口的适配器。 */
export function createLegacyHostSettingsStore<T>(scope: SettingsScope<T>): CodingNsSettingsStore<T> {
  const listeners = new Set<() => void>()
  const unsubscribe = scope.watch(() => {
    for (const listener of listeners) listener()
  })
  const store: CodingNsSettingsStore<T> = {
    getSnapshot: () => ({ value: scope.get(), revision: undefined, writable: true, status: 'ready' }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mutate: async (operations) => {
      const patch = operationsToPatch(operations)
      await scope.update(patch)
      return true
    },
    set: async (field, value) => {
      await scope.update({ [field]: value })
      return true
    },
    unset: async (field) => {
      const current = scope.get() as Record<string, unknown>
      const next = { ...current }
      delete next[field]
      await scope.replace(next)
      return true
    },
    dispose: () => unsubscribe(),
  }
  return store
}

function operationsToPatch(operations: readonly CodingNsSettingsOperation[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const operation of operations) {
    if (operation.path.length !== 1) throw new Error('旧版 SettingsScope 适配器只支持一级设置字段')
    const field = operation.path[0]!
    if (operation.op === 'unset') delete patch[field]
    else patch[field] = operation.value
  }
  return patch
}

export type CodingNsHostSettingsStore = CodingNsSettingsStore<CodingNsSettings>
export type { CodingNsSettingsOperation, CodingNsSettingsSnapshot }
