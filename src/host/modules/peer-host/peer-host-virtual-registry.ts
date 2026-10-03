import type {
  AggregateHostResult,
  AggregateWorkspaceOrder,
  AggregateWorkspaceSummary,
  PeerHostSessionRecord,
  VirtualSessionId,
  VirtualWorkspaceId,
  VirtualWorkspaceRef,
  VirtualSessionRef,
} from '../../../shared/contracts/peer-host.js'
import {
  createVirtualSessionId,
  createVirtualWorkspaceId,
  parseVirtualWorkspaceId,
} from '../../../shared/contracts/peer-host.js'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 聚合层可选的顺序存储；存储失败不能破坏当前内存中的排序。 */
export interface AggregateWorkspaceOrderStore {
  load(): Promise<readonly VirtualWorkspaceId[] | AggregateWorkspaceOrder | null> | readonly VirtualWorkspaceId[] | AggregateWorkspaceOrder | null
  save(order: AggregateWorkspaceOrder): Promise<void> | void
}

/** Host 侧顺序文件存储；文件内容只包含虚拟 ID，不包含远端正文或凭据。 */
export class FileAggregateWorkspaceOrderStore implements AggregateWorkspaceOrderStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<AggregateWorkspaceOrder | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      if (!isOrder(parsed)) return null
      return parsed
    } catch (error) {
      const code = error as NodeJS.ErrnoException
      if (code.code === 'ENOENT') return null
      throw error
    }
  }

  async save(order: AggregateWorkspaceOrder): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp-${process.pid}`
    await writeFile(tempPath, `${JSON.stringify(order)}\n`, 'utf8')
    await rename(tempPath, this.filePath)
  }
}

export interface VirtualWorkspaceEntry extends AggregateWorkspaceSummary {
  readonly virtualWorkspaceId: VirtualWorkspaceId
  readonly source: 'local' | 'peer'
}

export interface VirtualSessionEntry extends PeerHostSessionRecord {
  readonly virtualSessionId: VirtualSessionId
  readonly source: 'local' | 'peer'
}

/** 将本地和多个 PeerHost 摘要映射为单一 Host 可消费的虚拟资源表。 */
export class VirtualWorkspaceRegistry {
  private readonly workspaces = new Map<VirtualWorkspaceId, VirtualWorkspaceEntry>()
  private readonly sessions = new Map<VirtualSessionId, VirtualSessionEntry>()
  private order: VirtualWorkspaceId[] = []
  private orderStore: AggregateWorkspaceOrderStore | undefined
  // 一个 Host 可能同时服务多个页面；顺序文件使用固定临时路径，移动操作必须
  // 串行化，否则并发 rename 会互相覆盖或读到已被另一个操作替换的临时文件。
  private moveQueue: Promise<void> = Promise.resolve()

  constructor(options: { readonly order?: readonly VirtualWorkspaceId[]; readonly orderStore?: AggregateWorkspaceOrderStore } = {}) {
    this.order = uniqueIds(options.order ?? [])
    this.orderStore = options.orderStore
  }

  /** 替换一次聚合快照；旧 Host/Workspace 不会残留在表中。 */
  replace(results: readonly AggregateHostResult[]): void {
    this.workspaces.clear()
    this.sessions.clear()
    for (const host of results) {
      const virtualHostId = host.targetHostId ?? host.hostId
      for (const workspace of host.workspaces) {
        const virtualWorkspaceId = createVirtualWorkspaceId(virtualHostId, workspace.workspaceId)
        const entry: VirtualWorkspaceEntry = {
          ...workspace,
          virtualWorkspaceId,
          source: host.targetHostId === null ? 'local' : 'peer',
        }
        this.workspaces.set(virtualWorkspaceId, entry)
        for (const session of allWorkspaceSessions(workspace)) {
          if (session.scope.sessionId === null) continue
          const virtualSessionId = createVirtualSessionId(virtualHostId, session.scope.sessionId)
          this.sessions.set(virtualSessionId, {
            ...session,
            virtualSessionId,
            source: host.targetHostId === null ? 'local' : 'peer',
          })
        }
      }
    }
    this.order = this.reconcileOrder(this.order)
  }

  /** 从持久化存储恢复顺序，未知/重复 ID 会被过滤，新的 Workspace 追加到末尾。 */
  async hydrateOrder(): Promise<readonly VirtualWorkspaceId[]> {
    if (this.orderStore === undefined) return this.listWorkspaceIds()
    const persisted = await this.orderStore.load()
    const ids = Array.isArray(persisted)
      ? persisted.filter((id): id is string => typeof id === 'string')
      : isOrder(persisted)
        ? persisted.orderedWorkspaceIds
        : []
    this.order = this.reconcileOrder(ids)
    return this.listWorkspaceIds()
  }

  list(): readonly VirtualWorkspaceEntry[] {
    return this.order.flatMap((id) => {
      const workspace = this.workspaces.get(id)
      return workspace === undefined ? [] : [workspace]
    })
  }

  listWorkspaceIds(): readonly VirtualWorkspaceId[] {
    return this.order.filter((id) => this.workspaces.has(id))
  }

  /** 返回包含离线/暂未加载资源的顺序，用于持久化和重连恢复。 */
  listPersistedWorkspaceIds(): readonly VirtualWorkspaceId[] {
    return [...this.order]
  }

  get(virtualWorkspaceId: VirtualWorkspaceId): VirtualWorkspaceEntry | null {
    return this.workspaces.get(virtualWorkspaceId) ?? null
  }

  listSessions(virtualWorkspaceId: VirtualWorkspaceId): readonly VirtualSessionEntry[] {
    const workspace = this.workspaces.get(virtualWorkspaceId)
    if (workspace === undefined) return []
    return allWorkspaceSessions(workspace).flatMap((session) => {
      const sessionId = session.scope.sessionId
      if (sessionId === null) return []
      const virtualSessionId = createVirtualSessionId(workspace.targetHostId ?? workspace.hostId, sessionId)
      return [this.sessions.get(virtualSessionId)].filter((value): value is VirtualSessionEntry => value !== undefined)
    })
  }

  resolveWorkspace(virtualWorkspaceId: VirtualWorkspaceId): VirtualWorkspaceRef | null {
    const workspace = this.workspaces.get(virtualWorkspaceId)
    if (workspace !== undefined) return { virtualWorkspaceId, hostId: workspace.hostId, targetHostId: workspace.targetHostId, workspaceId: workspace.workspaceId }
    return null
  }

  resolveSession(virtualSessionId: VirtualSessionId): VirtualSessionRef | null {
    const session = this.sessions.get(virtualSessionId)
    if (session !== undefined) {
      return {
        virtualSessionId,
        hostId: session.scope.hostId,
        targetHostId: session.scope.targetHostId,
        workspaceId: session.scope.workspaceId,
        sessionId: session.scope.sessionId!,
      }
    }
    return null
  }

  /** 将 Workspace 移到 before 之前；before 为 null 表示移动到末尾。 */
  async move(virtualWorkspaceId: VirtualWorkspaceId, beforeVirtualWorkspaceId: VirtualWorkspaceId | null): Promise<readonly VirtualWorkspaceId[]> {
    const operation = this.moveQueue.then(() => this.moveNow(virtualWorkspaceId, beforeVirtualWorkspaceId))
    this.moveQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async moveNow(virtualWorkspaceId: VirtualWorkspaceId, beforeVirtualWorkspaceId: VirtualWorkspaceId | null): Promise<readonly VirtualWorkspaceId[]> {
    // 原生 Remote 的 workspace/list 可能早于聚合摘要到达。只要 ID 是合法的
    // 虚拟 Workspace，就先纳入持久顺序；下一次 aggregate 会补齐真实记录。
    // 这样拖拽不会因为短暂的摘要竞态被拒绝。
    assertVirtualWorkspaceId(virtualWorkspaceId)
    if (beforeVirtualWorkspaceId === virtualWorkspaceId) return this.listPersistedWorkspaceIds()
    if (beforeVirtualWorkspaceId !== null) assertVirtualWorkspaceId(beforeVirtualWorkspaceId)
    const next = this.order.filter((id) => id !== virtualWorkspaceId)
    if (beforeVirtualWorkspaceId !== null && !this.order.includes(beforeVirtualWorkspaceId)) {
      // 目标项也可能只存在于原生 Remote 列表；先作为墓碑锚点加入顺序。
      next.push(beforeVirtualWorkspaceId)
    }
    if (beforeVirtualWorkspaceId === null) next.push(virtualWorkspaceId)
    else next.splice(next.indexOf(beforeVirtualWorkspaceId), 0, virtualWorkspaceId)
    this.order = next
    await this.persistOrder()
    // 返回完整持久顺序，客户端才能立即渲染刚刚移动的延迟聚合项。
    return this.listPersistedWorkspaceIds()
  }

  async persistOrder(): Promise<void> {
    if (this.orderStore !== undefined) await this.orderStore.save({ version: 1, orderedWorkspaceIds: this.listPersistedWorkspaceIds() })
  }

  private reconcileOrder(candidate: readonly VirtualWorkspaceId[]): VirtualWorkspaceId[] {
    const existing = new Set(this.workspaces.keys())
    const next = uniqueIds(candidate)
    for (const id of existing) if (!next.includes(id)) next.push(id)
    return next
  }
}

function assertVirtualWorkspaceId(value: string): asserts value is VirtualWorkspaceId {
  if (parseVirtualWorkspaceId(value) === null) throw new Error(`非法虚拟 Workspace ID: ${value}`)
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.trim() !== ''))]
}

/** 可见与归档会话都要进入虚拟资源表：归档会话仍需解析取消归档等原生请求。 */
function allWorkspaceSessions(workspace: AggregateWorkspaceSummary): readonly PeerHostSessionRecord[] {
  return [...workspace.sessions, ...(workspace.archivedSessions ?? [])]
}

function isOrder(value: unknown): value is AggregateWorkspaceOrder {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as { version?: unknown; orderedWorkspaceIds?: unknown }
  return candidate.version === 1
    && Array.isArray(candidate.orderedWorkspaceIds)
    && candidate.orderedWorkspaceIds.every((id): id is string => typeof id === 'string' && id.trim() !== '')
}
