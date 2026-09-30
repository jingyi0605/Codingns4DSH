import type { Context } from '@deepseek-ai/cordis'
import type { PeerHostNativeProjection, PeerHostVirtualWorkspaceView } from './peer-host-native-projection.js'
import { readNativeService, readNativeWorkspaceListStore } from './native-workspace-store.js'

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
  const store = readNativeWorkspaceListStore(input.uiContext)
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

/** 原生快照追加虚拟工作区与虚拟归档集合；快照形状不符时原样返回，注入失败不影响本机数据。 */
function mergeWorkspaceSnapshot(snapshot: unknown, virtual: readonly PeerHostVirtualWorkspaceView[]): unknown {
  const record = asRecord(snapshot)
  if (record === null || !Array.isArray(record.items) || virtual.length === 0) return snapshot
  const known = new Set(record.items.flatMap((item) => {
    const workspaceId = asRecord(item)?.workspaceId
    return typeof workspaceId === 'string' ? [workspaceId] : []
  }))
  const injected = virtual.filter((workspace) => !known.has(workspace.workspaceId))
  const archivedSessionIds = mergeArchivedSessionIds(record.archivedSessionIds, virtual)
  if (injected.length === 0 && archivedSessionIds === undefined) return snapshot
  return {
    ...record,
    items: [...record.items, ...injected],
    ...(archivedSessionIds === undefined ? {} : { archivedSessionIds }),
  }
}

/**
 * 把虚拟归档会话并入 Registry 级归档集合。
 *
 * 原生侧栏与归档入口都按这份集合判断会话是否已归档；没有新增时返回 undefined，
 * 让快照保持原引用。
 */
function mergeArchivedSessionIds(
  current: unknown,
  virtual: readonly PeerHostVirtualWorkspaceView[],
): readonly string[] | undefined {
  const local = Array.isArray(current) ? current.flatMap((id) => typeof id === 'string' ? [id] : []) : []
  const seen = new Set(local)
  const merged = [...local]
  for (const workspace of virtual) {
    for (const id of workspace.archivedSessionIds) {
      if (seen.has(id)) continue
      seen.add(id)
      merged.push(id)
    }
  }
  return merged.length === local.length ? undefined : merged
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
