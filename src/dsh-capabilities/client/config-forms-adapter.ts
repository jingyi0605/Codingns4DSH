import type { CodingNsSettings } from '../../shared/contracts/config.js'
import { accepted, type CodingNsSettingsStore } from '../settings-store.js'

/** 0.1.7 Client ConfigForm 的最小结构化边界。 */
export interface DshConfigForm<T> {
  getSnapshot(): { readonly value: T | undefined; readonly revision?: number; readonly writable: boolean; readonly status?: 'loading' | 'ready' | 'unavailable' }
  subscribe(listener: () => void): () => void
  mutate(operations: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[], expectedRevision?: number): Promise<void>
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

export interface DshClientConfigForms {
  get<T>(namespace: string): DshConfigForm<T> | undefined
}

/** 0.1.7 Client ConfigForm 路由适配器。 */
export function createConfigFormSettingsStore(
  forms: DshClientConfigForms,
  namespace: string,
): CodingNsSettingsStore<CodingNsSettings> {
  const form = forms.get<CodingNsSettings>(namespace)
  if (form === undefined) {
    return {
      getSnapshot: () => ({ value: undefined, revision: undefined, writable: false, status: 'unavailable' }),
      subscribe: () => () => undefined,
      mutate: async () => false,
      set: async () => false,
      unset: async () => false,
    }
  }
  return {
    getSnapshot: () => {
      const snapshot = form.getSnapshot()
      return { value: snapshot.value, revision: snapshot.revision, writable: snapshot.writable, status: snapshot.status ?? 'ready' }
    },
    subscribe: (listener) => form.subscribe(listener),
    mutate: (operations, revision) => accepted(form.mutate(operations, revision)),
    set: (field, value) => accepted(form.set(field, value)),
    unset: (field) => accepted(form.unset(field)),
  }
}
