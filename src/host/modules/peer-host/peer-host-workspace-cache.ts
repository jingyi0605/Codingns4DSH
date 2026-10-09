import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { AggregateHostResult, AggregateWorkspaceSummary, PeerHostRecord } from '../../../shared/contracts/peer-host.js'

// 缓存严格限定为导航摘要，额外字段不会写入磁盘，避免把凭据或消息正文带进缓存。
const sessionSchema = z.object({
  scope: z.object({ hostId: z.string(), targetHostId: z.string().nullable(), workspaceId: z.string(), sessionId: z.string().nullable(), scopeGeneration: z.number().int().nonnegative() }),
  title: z.string(),
  titleProjection: z.object({ kind: z.enum(['cached', 'sequenced']), asOfSeq: z.number().int(), values: z.object({ title: z.string().nullable() }) }).optional(),
  status: z.string(), activity: z.enum(['running', 'idle', 'unknown']).optional(), updatedAt: z.number(), blank: z.boolean(),
  adapterId: z.string().optional(), origin: z.literal('subagent').optional(), parentSessionId: z.string().optional(),
})
const workspaceSchema = z.object({
  key: z.string(), hostId: z.string(), targetHostId: z.string().nullable(), workspaceId: z.string(),
  displayName: z.string(), path: z.string(), hostLabel: z.string(), availability: z.enum(['ready', 'checking', 'unreachable', 'unsupported']),
  sessions: z.array(sessionSchema), archivedSessions: z.array(sessionSchema).optional(), subagentSessions: z.array(sessionSchema).optional(),
})
const entrySchema = z.object({
  peerHostId: z.string(), identity: z.string(), workspaces: z.array(workspaceSchema), dismissedWorkspaceIds: z.array(z.string()),
})
const cacheSchema = z.object({ version: z.literal(1), ownerUserId: z.string(), entries: z.array(entrySchema) })
interface CacheEntry {
  readonly peerHostId: string
  readonly identity: string
  readonly workspaces: readonly AggregateWorkspaceSummary[]
  dismissedWorkspaceIds: string[]
}

/**
 * 最后一次成功的远端导航摘要。添加配置决定资格，缓存只负责断线展示。
 *
 * 临时移除不写 visibleWorkspaceIds；成功重连会清空临时隐藏集合。所有操作串行，
 * 防止移除与聚合并发写入时丢失状态；文件原子替换，半写文件不会破坏旧缓存。
 */
export class PeerHostWorkspaceCache {
  private entries: CacheEntry[] | undefined
  private operation: Promise<void> = Promise.resolve()
  private readonly disconnectedPeers = new Set<string>()
  private persisted = ''

  constructor(private readonly path: string, private readonly ownerUserId: string) {}

  apply(results: readonly AggregateHostResult[], records: readonly PeerHostRecord[]): Promise<readonly AggregateHostResult[]> {
    return this.enqueue(async () => {
      await this.load()
      const peers = new Map(records.filter((record) => record.ownerUserId === this.ownerUserId
        && record.status !== 'disabled' && record.status !== 'identity_changed').map((record) => [record.id, record]))
      // 删除 Host、更换目标身份或取消添加，都不能借缓存重新显示旧资源。
      this.entries = this.entries!.flatMap((entry) => {
        const record = peers.get(entry.peerHostId)
        if (record === undefined || entry.identity !== identity(record)) return []
        const visible = new Set(record.visibleWorkspaceIds ?? [])
        return [{ ...entry, workspaces: entry.workspaces.filter((workspace) => visible.has(workspace.workspaceId)),
          dismissedWorkspaceIds: entry.dismissedWorkspaceIds.filter((id) => visible.has(id)) }]
      })
      this.disconnectedPeers.clear()
      const next = results.flatMap((host): AggregateHostResult[] => {
        if (host.targetHostId === null) return [host]
        const record = peers.get(host.targetHostId)
        if (record === undefined) return []
        const visible = new Set(record.visibleWorkspaceIds ?? [])
        const previous = this.entries!.find((entry) => entry.peerHostId === record.id)
        if (host.availability === 'ready') {
          const workspaces = host.workspaces.filter((workspace) => visible.has(workspace.workspaceId))
          const entry = entrySchema.parse({ peerHostId: record.id, identity: identity(record), workspaces, dismissedWorkspaceIds: [] }) as CacheEntry
          this.entries = [...this.entries!.filter((item) => item.peerHostId !== record.id), entry]
          return [{ ...host, hostLabel: record.displayName, hostColor: record.color ?? null, workspaces }]
        }
        this.disconnectedPeers.add(record.id)
        const hidden = new Set(previous?.dismissedWorkspaceIds ?? [])
        const workspaces = (previous?.workspaces ?? []).filter((workspace) => !hidden.has(workspace.workspaceId))
          .map((workspace): AggregateWorkspaceSummary => ({ ...workspace, hostId: host.hostId, hostLabel: record.displayName, availability: host.availability }))
        return [{ ...host, hostLabel: record.displayName, hostColor: record.color ?? null, workspaces }]
      })
      // 磁盘不可写时仍保留内存摘要，不能因为缓存持久化故障破坏正常导航。
      await this.persist().catch(() => { console.warn('[codingns4dsh:peer-host] workspace cache persistence failed') })
      return next
    })
  }

  dismiss(peerHostId: string, workspaceId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.load()
      if (!this.disconnectedPeers.has(peerHostId)) throw new Error('工作区已恢复连接，请刷新列表后重试')
      const entry = this.entries!.find((item) => item.peerHostId === peerHostId)
      if (entry === undefined || !entry.workspaces.some((workspace) => workspace.workspaceId === workspaceId)) throw new Error('未找到断开的工作区缓存')
      const previous = entry.dismissedWorkspaceIds
      entry.dismissedWorkspaceIds = [...new Set([...previous, workspaceId])]
      try { await this.persist() } catch (error) { entry.dismissedWorkspaceIds = previous; throw error }
    })
  }

  private async load(): Promise<void> {
    if (this.entries !== undefined) return
    this.entries = []
    try {
      const parsed = cacheSchema.safeParse(JSON.parse(await readFile(this.path, 'utf8')))
      if (!parsed.success || parsed.data.ownerUserId !== this.ownerUserId) return
      this.entries = parsed.data.entries as CacheEntry[]
      this.persisted = JSON.stringify(parsed.data)
    } catch {
      // 缺失、损坏或旧格式缓存只影响离线展示，下一次成功摘要会重建它。
    }
  }

  private async persist(): Promise<void> {
    const value = JSON.stringify({ version: 1, ownerUserId: this.ownerUserId, entries: this.entries })
    if (value === this.persisted) return
    await mkdir(dirname(this.path), { recursive: true })
    const temporaryPath = `${this.path}.tmp`
    await writeFile(temporaryPath, value, { mode: 0o600 })
    await rename(temporaryPath, this.path)
    this.persisted = value
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operation.then(task)
    this.operation = next.then(() => undefined, () => undefined)
    return next
  }
}

/** 路由或握手身份变化时丢弃旧缓存；磁盘不重复保存目标地址。 */
function identity(record: PeerHostRecord): string {
  return createHash('sha256').update(JSON.stringify([record.route, record.fingerprint])).digest('hex')
}
