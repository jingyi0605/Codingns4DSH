import type { Context } from '@deepseek-ai/cordis'

/** DSH 原生 Workspace 列表 Store；消费方只用到这两条读取通道。 */
export interface NativeWorkspaceListStore {
  getSnapshot: () => unknown
  subscribe: (listener: () => void) => () => void
}

/** 原生 Workspace 列表项的最小结构；PeerHost 虚拟工作区也由这份读取提供。 */
export interface NativeWorkspaceRecord {
  readonly workspaceId: string
  readonly path?: string
  readonly title: string
  readonly sessionIds: readonly string[]
}

/** `workspaces.list` 快照的最小结构；归档集合是 Registry 级共享的一份列表。 */
export interface NativeWorkspaceSnapshot {
  readonly items: readonly NativeWorkspaceRecord[]
  readonly archivedSessionIds: readonly string[]
}

/**
 * 读取原生 Workspace 列表 Store 对象本身。
 *
 * PeerHost 顺序投影必须就地改写这个对象的方法，归档入口只读它的快照。
 */
export function readNativeWorkspaceListStore(uiContext: Context | undefined): NativeWorkspaceListStore | undefined {
  const store = readNativeService(uiContext, 'workspaces', 'list')
  if (!isRecord(store) || typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') return undefined
  return store as unknown as NativeWorkspaceListStore
}

/** 读取原生 Workspace 快照；形状不符或服务缺失时返回 undefined，调用方退回原生 Remote。 */
export function readNativeWorkspaceSnapshot(uiContext: Context | undefined): NativeWorkspaceSnapshot | undefined {
  const store = readNativeWorkspaceListStore(uiContext)
  const snapshot = store?.getSnapshot()
  const record = isRecord(snapshot) ? snapshot : undefined
  if (record === undefined || !Array.isArray(record.items)) return undefined
  return {
    items: record.items.flatMap((item) => {
      const value = isRecord(item) ? item : undefined
      const workspaceId = readText(value?.workspaceId)
      if (workspaceId === undefined) return []
      const path = readText(value?.path)
      const title = readText(value?.title) ?? path ?? workspaceId
      return [{
        workspaceId,
        ...(path === undefined ? {} : { path }),
        title,
        sessionIds: readTextList(value?.sessionIds),
      }]
    }),
    archivedSessionIds: readTextList(record.archivedSessionIds),
  }
}

/** 读取 DSH 原生服务集合中的字段；非 Web 宿主或版本差异时保持缺失。 */
export function readNativeService(uiContext: Context | undefined, name: string, field?: string): unknown {
  if (uiContext === undefined) return undefined
  try {
    const getter = (uiContext as { get?: (service: string) => unknown }).get
    if (typeof getter !== 'function') return undefined
    const service = getter.call(uiContext, name)
    if (field === undefined) return service
    return isRecord(service) ? service[field] : undefined
  } catch {
    // 原生服务不可用（非 Web Client 宿主或版本差异）时保持本机行为。
    return undefined
  }
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function readTextList(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => { const text = readText(item); return text === undefined ? [] : [text] }) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
