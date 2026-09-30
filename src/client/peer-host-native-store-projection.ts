import type { Context } from '@deepseek-ai/cordis'
import type { PeerHostNativeProjection, PeerHostVirtualWorkspaceView } from './peer-host-native-projection.js'

/** DSH 原生 Workspace 列表 Store；消费方只用到这两条读取通道。 */
interface WorkspaceListStore {
  getSnapshot: () => unknown
  subscribe: (listener: () => void) => () => void
}

/**
 * 把虚拟工作区就地投影进 DSH 原生 Workspace Store。
 *
 * 原生侧栏在插件 apply 时按引用捕获 `workspaces.list`（`slots.provideRoot` 的 hooks
 * 与组件字段持有的是同一个对象），替换服务属性对它不可见；因此这里只改写这个对象
 * 自己的读取方法，写入口保持原生行为，禁用 PeerHost 后可以原样还原。
 */
export function installPeerHostNativeStoreProjection(input: {
  readonly uiContext: Context | undefined
  readonly projection: PeerHostNativeProjection
}): () => void {
  const store = readWorkspaceListStore(input.uiContext)
  if (store === undefined) return () => undefined
  const ownsGetSnapshot = Object.hasOwn(store, 'getSnapshot')
  const ownsSubscribe = Object.hasOwn(store, 'subscribe')
  const originalGetSnapshot = store.getSnapshot
  const originalSubscribe = store.subscribe
  // `useSyncExternalStore` 要求快照引用稳定：按（原生快照, 虚拟资源）两个引用记忆化，
  // 聚合没变时返回同一个合并结果，避免原生组件无限重渲染。
  let cachedBase: unknown
  let cachedVirtual: readonly PeerHostVirtualWorkspaceView[] | undefined
  let cachedMerged: unknown
  store.getSnapshot = function patchedGetSnapshot(this: unknown): unknown {
    const base = originalGetSnapshot.call(this)
    const virtual = input.projection.workspaces()
    if (base === cachedBase && virtual === cachedVirtual) return cachedMerged
    cachedBase = base
    cachedVirtual = virtual
    cachedMerged = mergeWorkspaceSnapshot(base, virtual)
    return cachedMerged
  }
  store.subscribe = function patchedSubscribe(this: unknown, listener: () => void): () => void {
    const disposeStore = originalSubscribe.call(this, listener)
    const disposeProjection = input.projection.subscribe(listener)
    return () => {
      disposeProjection()
      disposeStore()
    }
  }
  return () => {
    if (ownsGetSnapshot) store.getSnapshot = originalGetSnapshot
    else delete (store as { getSnapshot?: unknown }).getSnapshot
    if (ownsSubscribe) store.subscribe = originalSubscribe
    else delete (store as { subscribe?: unknown }).subscribe
  }
}

function readWorkspaceListStore(uiContext: Context | undefined): WorkspaceListStore | undefined {
  const store = readNativeService(uiContext, 'workspaces', 'list')
  if (!isRecord(store) || typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') return undefined
  return store as unknown as WorkspaceListStore
}

/**
 * 触发一次原生会话列表刷新。
 *
 * 虚拟会话必须进入原生 SessionManager 目录（否则点击时 `sessions.retain` 解析失败），
 * 因此聚合变化后主动刷新一次；虚拟会话由页面 Transport 在 `session/list` 响应里补齐。
 */
export async function refreshPeerHostNativeSessions(uiContext: Context | undefined): Promise<void> {
  const sessions = readNativeService(uiContext, 'sessions')
  const refresh = isRecord(sessions) ? sessions.refresh : undefined
  if (typeof refresh !== 'function') return
  try {
    await (refresh as () => unknown).call(sessions)
  } catch {
    // 原生刷新失败只影响远端会话可见性，本机列表保持可用。
  }
}

function readNativeService(uiContext: Context | undefined, name: string, field?: string): unknown {
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

/** 原生快照追加虚拟工作区；快照形状不符时原样返回，注入失败不影响本机数据。 */
function mergeWorkspaceSnapshot(snapshot: unknown, virtual: readonly PeerHostVirtualWorkspaceView[]): unknown {
  const record = asRecord(snapshot)
  if (record === null || !Array.isArray(record.items) || virtual.length === 0) return snapshot
  const known = new Set(record.items.flatMap((item) => {
    const workspaceId = asRecord(item)?.workspaceId
    return typeof workspaceId === 'string' ? [workspaceId] : []
  }))
  const injected = virtual.filter((workspace) => !known.has(workspace.workspaceId))
  if (injected.length === 0) return snapshot
  return { ...record, items: [...record.items, ...injected] }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
