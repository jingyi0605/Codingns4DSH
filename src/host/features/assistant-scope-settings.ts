import { createAssistantScope, getAssistantScopeState, type AssistantScope } from './assistant-scope.js'

export interface AssistantScopeSettingsStore {
  read(): readonly string[] | Promise<readonly string[]>
  write(workspaceIds: readonly string[]): void | Promise<void>
}
export interface AssistantScopeSettingsSnapshot {
  readonly scope: AssistantScope
  readonly state: ReturnType<typeof getAssistantScopeState>
}

export type AssistantScopeChangedListener = (snapshot: AssistantScopeSettingsSnapshot) => void

/**
 * 受管范围的注入式设置边界。默认空范围，只有用户显式调用 setManagedWorkspaceIds
 * 才会改变选择；真实设置服务在外围注入，不让纯逻辑依赖 DSH。
 */
export class AssistantScopeSettings {
  private scope = createAssistantScope([])
  private readonly listeners = new Set<AssistantScopeChangedListener>()

  constructor(private readonly store: AssistantScopeSettingsStore) {}

  async load(): Promise<AssistantScopeSettingsSnapshot> {
    this.scope = createAssistantScope(await this.store.read())
    return this.snapshot()
  }

  snapshot(): AssistantScopeSettingsSnapshot {
    return { scope: this.scope, state: getAssistantScopeState(this.scope) }
  }

  async setManagedWorkspaceIds(workspaceIds: readonly string[]): Promise<AssistantScopeSettingsSnapshot> {
    this.scope = createAssistantScope(workspaceIds)
    await this.store.write(this.scope.managedWorkspaceIds)
    const snapshot = this.snapshot()
    for (const listener of [...this.listeners]) listener(snapshot)
    return snapshot
  }

  subscribe(listener: AssistantScopeChangedListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
