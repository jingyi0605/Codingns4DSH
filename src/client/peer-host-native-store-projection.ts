import type { Context } from '@deepseek-ai/cordis'
import { createPeerHostWorkspaceDisplayPath, type PeerHostNativeProjection, type PeerHostVirtualWorkspaceView } from './peer-host-native-projection.js'
import { createVirtualWorkspaceId, parseVirtualWorkspaceId } from '../shared/contracts/peer-host.js'
import { readNativeService, readNativeWorkspaceListStore } from './native-workspace-store.js'

interface NativeWorkspaceServiceHandle {
  insertBefore?: (...args: unknown[]) => unknown
  [key: string]: unknown
}

interface NativeSnapshotStoreHandle {
  getSnapshot: () => unknown
  subscribe: (listener: () => void) => () => void
}

/**
 * 把虚拟工作区就地投影进 DSH 原生 Workspace Store。
 *
 * 原生侧栏在插件 apply 时按引用捕获 `workspaces.list`（`slots.provideRoot` 的 hooks
 * 与组件字段持有的是同一个对象），替换服务属性对它不可见；因此这里只改写这个对象
 * 自己的读取方法，并就地包装拖拽写入口，禁用 PeerHost 后可以原样还原。
 */
export function installPeerHostNativeStoreProjection(input: {
  readonly uiContext: Context | undefined
  readonly projection: PeerHostNativeProjection
  /** 将原生拖拽写入 Host 侧持久化的混合顺序。 */
  readonly moveWorkspace?: (virtualWorkspaceId: string, beforeVirtualWorkspaceId: string | null) => Promise<readonly string[]>
  /** 拖拽发生在首次聚合完成前时，主动刷新 Host 顺序并更新投影。 */
  readonly refreshWorkspaceOrder?: () => Promise<readonly string[]>
}): () => void {
  const store = readNativeWorkspaceListStore(input.uiContext)
  if (store === undefined) return () => undefined
  const service = readNativeService(input.uiContext, 'workspaces')
  const serviceRecord = isRecord(service) ? service as NativeWorkspaceServiceHandle : undefined
  const sessionStoreValue = readNativeService(input.uiContext, 'sessions', 'list')
  const sessionStore = isSnapshotStore(sessionStoreValue) ? sessionStoreValue : undefined
  const ownsGetSnapshot = Object.hasOwn(store, 'getSnapshot')
  const ownsSubscribe = Object.hasOwn(store, 'subscribe')
  const originalGetSnapshot = store.getSnapshot
  const originalSubscribe = store.subscribe
  const originalInsertBefore = serviceRecord?.insertBefore
  const ownsInsertBefore = serviceRecord === undefined ? false : Object.hasOwn(serviceRecord, 'insertBefore')
  // `useSyncExternalStore` 要求快照引用稳定：按（原生快照, 虚拟资源）两个引用记忆化，
  // 聚合没变时返回同一个合并结果，避免原生组件无限重渲染。
  let cachedBase: unknown
  let cachedVirtual: readonly PeerHostVirtualWorkspaceView[] | undefined
  let cachedOrder: readonly string[] | undefined
  let cachedLocalHostId: string | undefined
  let cachedMerged: unknown
  store.getSnapshot = function patchedGetSnapshot(this: unknown): unknown {
    const base = originalGetSnapshot.call(this)
    const virtual = input.projection.workspaces()
    const order = input.projection.workspaceOrder()
    const localHostId = input.projection.localHostId()
    if (base === cachedBase && virtual === cachedVirtual && order === cachedOrder && localHostId === cachedLocalHostId) return cachedMerged
    cachedBase = base
    cachedVirtual = virtual
    cachedOrder = order
    cachedLocalHostId = localHostId
    cachedMerged = mergeWorkspaceSnapshot(base, virtual, order, localHostId)
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
  const patchedInsertBefore = installWorkspaceInsertBeforeProjection(serviceRecord, originalInsertBefore, input)
  const restoreSessionStore = installSessionDisplayPathProjection(store, sessionStore)
  return () => {
    if (ownsGetSnapshot) store.getSnapshot = originalGetSnapshot
    else delete (store as { getSnapshot?: unknown }).getSnapshot
    if (ownsSubscribe) store.subscribe = originalSubscribe
    else delete (store as { subscribe?: unknown }).subscribe
    if (serviceRecord !== undefined && patchedInsertBefore !== undefined && serviceRecord.insertBefore === patchedInsertBefore) {
      if (ownsInsertBefore) {
        if (originalInsertBefore === undefined) delete serviceRecord.insertBefore
        else serviceRecord.insertBefore = originalInsertBefore
      } else delete serviceRecord.insertBefore
    }
    restoreSessionStore()
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

/** 合并并按 Host 侧顺序排列工作区；快照形状不符时原样返回，注入失败不影响本机数据。 */
function mergeWorkspaceSnapshot(
  snapshot: unknown,
  virtual: readonly PeerHostVirtualWorkspaceView[],
  orderedWorkspaceIds: readonly string[],
  localHostId: string | undefined,
): unknown {
  const record = asRecord(snapshot)
  if (record === null || !Array.isArray(record.items)) return snapshot
  const items = record.items as readonly unknown[]
  const known = new Set(items.flatMap((item) => {
    const workspaceId = asRecord(item)?.workspaceId
    if (typeof workspaceId !== 'string') return []
    const normalized = normalizeWorkspaceId(workspaceId, localHostId)
    return normalized === workspaceId ? [workspaceId] : [workspaceId, normalized]
  }))
  const injected = virtual.filter((workspace) => !known.has(workspace.workspaceId))
  const archivedSessionIds = mergeArchivedSessionIds(record.archivedSessionIds, virtual)
  const orderedItems = orderWorkspaceItems([...items, ...injected], orderedWorkspaceIds, localHostId)
  // 只规范化远端虚拟条目的显示路径；本地条目必须保留真实路径，文件面板才能继续
  // 使用本机目录。远端文件请求会在 Host 转发边界把这个虚拟路径还原。
  const mergedItems = normalizeRemoteWorkspaceDisplayPaths(orderedItems)
  const itemsChanged = mergedItems.length !== items.length || mergedItems.some((item, index) => item !== items[index])
  if (!itemsChanged && archivedSessionIds === undefined) return snapshot
  return {
    ...record,
    items: mergedItems,
    ...(archivedSessionIds === undefined ? {} : { archivedSessionIds }),
  }
}

/** 原生 Remote 可能先把远端条目写入底层 Store，仍需强制保持扁平虚拟显示路径。 */
function normalizeRemoteWorkspaceDisplayPaths(items: readonly unknown[]): readonly unknown[] {
  let changed = false
  const normalized = items.map((item) => {
    const record = asRecord(item)
    const workspaceId = record?.workspaceId
    if (record === null || typeof workspaceId !== 'string' || parseVirtualWorkspaceId(workspaceId) === null) return item
    const displayPath = createPeerHostWorkspaceDisplayPath(workspaceId)
    if (record.path === displayPath) return item
    changed = true
    return { ...record, path: displayPath }
  })
  return changed ? normalized : items
}

/**
 * 原生会话列表只把空白会话的 cwd 用于判断是否能复用；同步工作区真实路径即可
 * 保留该判断，正式会话也继续保留真实 cwd，避免 Git、文件面板或远端工具拿到虚拟 URI。
 */
function installSessionDisplayPathProjection(
  workspaceStore: NativeSnapshotStoreHandle,
  sessionStore: NativeSnapshotStoreHandle | undefined,
): () => void {
  if (sessionStore === undefined) return () => undefined
  const originalGetSnapshot = sessionStore.getSnapshot
  const originalSubscribe = sessionStore.subscribe
  const ownsGetSnapshot = Object.hasOwn(sessionStore, 'getSnapshot')
  const ownsSubscribe = Object.hasOwn(sessionStore, 'subscribe')
  let cachedBase: unknown
  let cachedWorkspaceSnapshot: unknown
  let cachedMerged: unknown
  const patchedGetSnapshot = function patchedSessionGetSnapshot(this: unknown): unknown {
    const base = originalGetSnapshot.call(this)
    const workspaceSnapshot = workspaceStore.getSnapshot()
    if (base === cachedBase && workspaceSnapshot === cachedWorkspaceSnapshot) return cachedMerged
    cachedBase = base
    cachedWorkspaceSnapshot = workspaceSnapshot
    cachedMerged = mergeBlankSessionCwds(base, workspaceSnapshot)
    return cachedMerged
  }
  const patchedSubscribe = function patchedSessionSubscribe(this: unknown, listener: () => void): () => void {
    const disposeStore = originalSubscribe.call(this, listener)
    const disposeWorkspace = workspaceStore.subscribe(listener)
    return () => {
      disposeWorkspace()
      disposeStore()
    }
  }
  sessionStore.getSnapshot = patchedGetSnapshot
  sessionStore.subscribe = patchedSubscribe
  return () => {
    if (sessionStore.getSnapshot === patchedGetSnapshot) {
      if (ownsGetSnapshot) sessionStore.getSnapshot = originalGetSnapshot
      else delete (sessionStore as { getSnapshot?: unknown }).getSnapshot
    }
    if (sessionStore.subscribe === patchedSubscribe) {
      if (ownsSubscribe) sessionStore.subscribe = originalSubscribe
      else delete (sessionStore as { subscribe?: unknown }).subscribe
    }
  }
}

function mergeBlankSessionCwds(snapshot: unknown, workspaceSnapshot: unknown): unknown {
  const state = asRecord(snapshot)
  const byId = state?.byId
  const workspaceState = asRecord(workspaceSnapshot)
  const items = Array.isArray(workspaceState?.items) ? workspaceState.items : []
  if (state === null || !isRecord(byId) || items.length === 0) return snapshot
  let changed = false
  const nextById: Record<string, unknown> = { ...byId }
  for (const [id, value] of Object.entries(byId)) {
    const session = asRecord(value)
    if (session === null || session.blank !== true) continue
    const workspace = items.find((item) => {
      const record = asRecord(item)
      return Array.isArray(record?.sessionIds) && record.sessionIds.includes(id)
    })
    const displayPath = asRecord(workspace)?.path
    if (typeof displayPath !== 'string' || displayPath === '' || session.cwd === displayPath) continue
    nextById[id] = { ...session, cwd: displayPath }
    changed = true
  }
  return changed ? { ...state, byId: nextById } : snapshot
}

function installWorkspaceInsertBeforeProjection(
  service: NativeWorkspaceServiceHandle | undefined,
  original: NativeWorkspaceServiceHandle['insertBefore'],
  input: {
    readonly projection: PeerHostNativeProjection
    readonly moveWorkspace?: (virtualWorkspaceId: string, beforeVirtualWorkspaceId: string | null) => Promise<readonly string[]>
    readonly refreshWorkspaceOrder?: () => Promise<readonly string[]>
  },
): NativeWorkspaceServiceHandle['insertBefore'] | undefined {
  const moveWorkspace = input.moveWorkspace
  if (service === undefined || typeof original !== 'function' || moveWorkspace === undefined) return undefined
  const originalInsertBefore = original
  // 原生拖拽可能在上一次 RPC 尚未返回时再次触发；串行化移动，保证后一个操作
  // 基于已经确认的顺序计算，避免响应乱序把列表写回旧位置。
  let moveQueue: Promise<void> = Promise.resolve()
  const execute = async function(this: unknown, workspaceId: unknown, beforeWorkspaceId?: unknown): Promise<unknown> {
    if (typeof workspaceId !== 'string') return callOriginalInsertBefore(originalInsertBefore, this, workspaceId, beforeWorkspaceId)
    let localHostId = input.projection.localHostId()
    let sourceVirtualId = normalizeWorkspaceId(workspaceId, localHostId)
    let beforeVirtualId = beforeWorkspaceId === undefined || beforeWorkspaceId === null
      ? null
      : typeof beforeWorkspaceId === 'string' ? normalizeWorkspaceId(beforeWorkspaceId, localHostId) : null
    const sourceIsVirtual = parseVirtualWorkspaceId(workspaceId) !== null
    const beforeIsVirtual = typeof beforeWorkspaceId === 'string' && parseVirtualWorkspaceId(beforeWorkspaceId) !== null
    let previousOrder = input.projection.workspaceOrder()
    // 本地原生条目在 localHostId 尚未从聚合快照到达时仍是裸 ID；Host 端会按
    // 本地注册表把它解析成虚拟 ID，因此这类输入也可以先提交。远端虚拟 ID
    // 必须保持合法格式，不能把任意字符串交给顺序 RPC。
    const idsReady = (): boolean => (sourceVirtualId !== null || !sourceIsVirtual)
      && (beforeWorkspaceId === undefined || beforeWorkspaceId === null || beforeVirtualId !== null || !beforeIsVirtual)
    // 原生 Remote 可能先把虚拟工作区写入列表，聚合摘要随后才到达。
    // 顺序快照暂时缺少该 ID 并不意味着拖拽无效；Host Registry 会把合法的
    // 虚拟 ID作为延迟聚合/离线墓碑纳入顺序文件，不能在客户端提前拒绝。
    const orderReady = (): boolean => idsReady()
    // 裸本地 ID可以由 Host 端按稳定 localHostId 解析；拖拽路径不能为了补齐
    // 聚合摘要而同步等待远端超时。顺序快照缺项也由 Host Registry 记录墓碑。
    const needsHydration = !idsReady()
    if ((needsHydration || !orderReady()) && input.refreshWorkspaceOrder !== undefined) {
      try {
        const refreshedOrder = await input.refreshWorkspaceOrder()
        input.projection.setWorkspaceOrder(refreshedOrder)
        previousOrder = input.projection.workspaceOrder()
        localHostId = input.projection.localHostId()
        sourceVirtualId = normalizeWorkspaceId(workspaceId, localHostId)
        beforeVirtualId = beforeWorkspaceId === undefined || beforeWorkspaceId === null
          ? null
          : typeof beforeWorkspaceId === 'string' ? normalizeWorkspaceId(beforeWorkspaceId, localHostId) : null
      } catch {
        // 下面统一走稳定的拒绝分支；不要把网络或旧 Host 错误透传给原生 Controller。
      }
    }
    if (!idsReady() || !orderReady()) {
      if (sourceIsVirtual || beforeIsVirtual) throw new Error('PeerHost Workspace 顺序尚未就绪，拒绝把虚拟 ID发给原生 Host')
      return callOriginalInsertBefore(originalInsertBefore, this, workspaceId, beforeWorkspaceId)
    }
    if (sourceVirtualId === null && sourceIsVirtual) {
      if (sourceIsVirtual || beforeIsVirtual) throw new Error('PeerHost Workspace 顺序尚未就绪，拒绝把虚拟 ID发给原生 Host')
      return callOriginalInsertBefore(originalInsertBefore, this, workspaceId, beforeWorkspaceId)
    }
    if (beforeWorkspaceId !== undefined && beforeWorkspaceId !== null && beforeVirtualId === null && beforeIsVirtual) {
      throw new Error('PeerHost Workspace 顺序尚未就绪，拒绝把虚拟 ID发给原生 Host')
    }
    const sourceId = sourceVirtualId ?? workspaceId
    const beforeId = beforeVirtualId ?? (typeof beforeWorkspaceId === 'string' ? beforeWorkspaceId : null)
    const previousBefore = previousOrder[previousOrder.indexOf(sourceId) + 1] ?? null
    // 先更新投影，原生侧栏可以立即完成布局；Host 顺序 RPC 只负责持久化。
    // 网络失败时恢复拖拽前的顺序，避免显示层与持久层分叉。
    const optimisticOrder = moveWorkspaceOrder(previousOrder, sourceId, beforeId)
    input.projection.setWorkspaceOrder(optimisticOrder)
    let nextOrder: readonly string[]
    try {
      nextOrder = await moveWorkspace(sourceId, beforeId)
    } catch (error) {
      input.projection.setWorkspaceOrder(previousOrder)
      throw error
    }
    input.projection.setWorkspaceOrder(nextOrder)
    // 远端条目没有本机实体；跨 Host 拖动只需要更新 Host 侧顺序。涉及本地项时，
    // 仍让原生 Controller 更新自己的局部顺序，避免 DSH 的本地 Store 失去写入语义。
    if (!sourceIsVirtual && (beforeWorkspaceId === undefined || beforeWorkspaceId === null || !beforeIsVirtual)) {
      try {
        await callOriginalInsertBefore(originalInsertBefore, this, workspaceId, beforeWorkspaceId)
      } catch (error) {
        if (previousOrder.includes(sourceId)) {
          try {
            const rollbackOrder = await moveWorkspace(sourceId, previousBefore)
            input.projection.setWorkspaceOrder(rollbackOrder)
          } catch {
            // Host 侧顺序已经成功写入时，原生 Controller 失败不应掩盖原始错误。
          }
        }
        throw error
      }
    }
    return undefined
  }
  const patched = function(this: unknown, workspaceId: unknown, beforeWorkspaceId?: unknown): Promise<unknown> {
    const operation = moveQueue.then(() => execute.call(this, workspaceId, beforeWorkspaceId))
    moveQueue = operation.then(() => undefined, () => undefined)
    return operation
  }
  service.insertBefore = patched
  return patched
}

/** 在等待 Host 应答期间计算本地混合顺序；缺失项按墓碑锚点规则补入。 */
function moveWorkspaceOrder(
  current: readonly string[],
  sourceId: string,
  beforeId: string | null,
): readonly string[] {
  const next = current.filter((id) => id !== sourceId)
  if (beforeId !== null && !next.includes(beforeId)) next.push(beforeId)
  if (beforeId === null) next.push(sourceId)
  else next.splice(next.indexOf(beforeId), 0, sourceId)
  return next
}

function callOriginalInsertBefore(
  original: (...args: unknown[]) => unknown,
  receiver: unknown,
  workspaceId: unknown,
  beforeWorkspaceId: unknown,
): unknown {
  if (beforeWorkspaceId === undefined || beforeWorkspaceId === null) return original.call(receiver, workspaceId)
  return original.call(receiver, workspaceId, beforeWorkspaceId)
}

function orderWorkspaceItems(
  items: readonly unknown[],
  orderedWorkspaceIds: readonly string[],
  localHostId: string | undefined,
): readonly unknown[] {
  if (orderedWorkspaceIds.length === 0 || items.length < 2) return items
  // 本地摘要短暂不可用时，Host 端 order 只会返回远端活动项；此时不能把本机
  // 原生条目误判成“未知新项”并整体推到远端之后，保留原生顺序等待下一轮聚合。
  if (localHostId === undefined && items.some((item) => {
    const workspaceId = asRecord(item)?.workspaceId
    return typeof workspaceId === 'string' && parseVirtualWorkspaceId(workspaceId) === null
  })) return items
  const hasLocalItem = localHostId !== undefined && items.some((item) => {
    const workspaceId = asRecord(item)?.workspaceId
    return typeof workspaceId === 'string' && parseVirtualWorkspaceId(workspaceId) === null
  })
  const hasLocalOrder = localHostId !== undefined && orderedWorkspaceIds.some((id) => parseVirtualWorkspaceId(id)?.hostId === localHostId)
  if (hasLocalItem && !hasLocalOrder) return items
  const ranks = new Map(orderedWorkspaceIds.map((id, index) => [id, index]))
  const entries = items.map((item, index) => {
    const workspaceId = asRecord(item)?.workspaceId
    const normalized = typeof workspaceId === 'string' ? normalizeWorkspaceId(workspaceId, localHostId) : null
    return { item, index, normalized }
  })
  // 聚合与顺序 RPC 可能跨越一次刷新边界：若当前快照中有条目尚未出现在
  // 顺序列表，暂时保留原生顺序，避免把该条目错误地推到列表尾部造成抖动。
  if (entries.some((entry) => entry.normalized === null || !ranks.has(entry.normalized))) return items
  return entries
    .map((entry) => ({ ...entry, rank: ranks.get(entry.normalized!)! }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.item)
}

function normalizeWorkspaceId(workspaceId: string, localHostId: string | undefined): string | null {
  if (parseVirtualWorkspaceId(workspaceId) !== null) return workspaceId
  return localHostId === undefined ? null : createVirtualWorkspaceId(localHostId, workspaceId)
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

function isSnapshotStore(value: unknown): value is NativeSnapshotStoreHandle {
  return isRecord(value) && typeof value.getSnapshot === 'function' && typeof value.subscribe === 'function'
}
