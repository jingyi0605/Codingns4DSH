import { readAssistantNotificationFeed, type AssistantNotificationFeed, type AssistantNotificationFeedRequest } from '../../shared/assistant-notification-feed.js'
import { assistantWorkspaceMatches } from '../../shared/assistant-lifecycle.js'
import type { PeerHostRecord } from '../../shared/contracts/peer-host.js'

export interface AssistantPeerNotificationNode {
  readonly hostId: string
  readonly hostLabel: string
  /** 连接地址、指纹和版本共同标记能力代次；暂时连接状态不重建来源。 */
  readonly capabilityKey: string
  readonly workspaceIds: readonly string[]
}
/** checking/unreachable/ready 是同一来源的状态，重建会丢失待办的收起与已读。 */
export function assistantPeerNotificationCapabilityKey(record: Pick<PeerHostRecord, 'route' | 'fingerprint' | 'pluginVersion'>): string {
  return JSON.stringify([record.route, record.fingerprint, record.pluginVersion])
}
/** 原始工作区 ID 属于本机；远端必须显式选中带 Host 身份的范围。 */
export function assistantPeerNotificationWorkspaceIds(hostId: string, visibleWorkspaceIds: readonly string[], managedWorkspaceIds: readonly string[]): readonly string[] {
  return visibleWorkspaceIds.filter(workspaceId => managedWorkspaceIds.some(selected => selected !== workspaceId && assistantWorkspaceMatches(selected, hostId, workspaceId)))
}
export interface AssistantPeerNotificationUpdate {
  readonly hostId: string
  readonly hostLabel: string
  readonly connectionGeneration: number
  readonly feed: AssistantNotificationFeed
}
export interface AssistantPeerNotificationObserver {
  onUpdate(update: AssistantPeerNotificationUpdate): void
  onUnavailable(hostId: string, connectionGeneration: number, reason: string, unsupported: boolean): void
  onRemove?(hostId: string): void
}
export interface AssistantPeerNotificationsOptions {
  nodes(signal: AbortSignal): Promise<readonly AssistantPeerNotificationNode[]>
  read(node: AssistantPeerNotificationNode, request: AssistantNotificationFeedRequest, signal: AbortSignal): Promise<unknown>
  readonly observer: AssistantPeerNotificationObserver
  readonly intervalMs?: number
}
interface Worker {
  node: AssistantPeerNotificationNode
  readonly key: string
  readonly controller: AbortController
  generation: number
  epoch?: string
  revision?: number
  digest?: string
  unsupported: boolean
}

/** 每个受管 Host 一个串行增量读取；永不从空闲摘要或会话正文推导终态。 */
export class AssistantPeerNotifications {
  private readonly controller = new AbortController()
  private readonly workers = new Map<string, Worker>()
  private readonly sequences = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | undefined
  private refreshing = false

  constructor(private readonly options: AssistantPeerNotificationsOptions, signal?: AbortSignal) {
    if (signal?.aborted) this.controller.abort(signal.reason)
    signal?.addEventListener('abort', this.dispose, { once: true })
    this.controller.signal.addEventListener('abort', () => signal?.removeEventListener('abort', this.dispose), { once: true })
  }

  start(): () => void {
    if (this.controller.signal.aborted) return this.dispose
    if (this.timer === undefined) {
      this.timer = setInterval(() => { void this.refresh() }, this.interval())
      this.timer.unref?.()
      void this.refresh()
    }
    return this.dispose
  }

  /** 范围和已配置 Host 变化由本机元数据驱动，不对每条会话开轮询。 */
  async refresh(): Promise<void> {
    if (this.refreshing || this.controller.signal.aborted) return
    this.refreshing = true
    try {
      const nodes = await this.options.nodes(this.controller.signal)
      if (this.controller.signal.aborted) return
      const current = new Map(nodes.map(node => [node.hostId, node]))
      for (const [hostId, worker] of this.workers) {
        const node = current.get(hostId)
        if (node !== undefined && worker.key === nodeKey(node)) { worker.node = node; continue }
        worker.controller.abort()
        this.workers.delete(hostId)
        this.options.observer.onRemove?.(hostId)
      }
      for (const node of nodes) {
        if (this.workers.has(node.hostId) || node.workspaceIds.length === 0) continue
        const worker: Worker = { node, key: nodeKey(node), controller: new AbortController(), generation: this.nextGeneration(node.hostId), unsupported: false }
        this.workers.set(node.hostId, worker)
        void this.pump(worker)
      }
    } catch {
      // 元数据读取临时失败不制造会话失败；下一轮重新同步，旧事件仍受取消信号保护。
    } finally { this.refreshing = false }
  }

  readonly dispose = (): void => {
    if (this.controller.signal.aborted && this.workers.size === 0 && this.timer === undefined) return
    this.controller.abort()
    clearInterval(this.timer); this.timer = undefined
    for (const worker of this.workers.values()) worker.controller.abort()
    this.workers.clear(); this.sequences.clear()
  }

  private async pump(worker: Worker): Promise<void> {
    const signal = AbortSignal.any([this.controller.signal, worker.controller.signal])
    let attempts = 0
    while (!signal.aborted && !worker.unsupported) {
      try {
        const raw = await this.options.read(worker.node, {
          workspaceIds: worker.node.workspaceIds,
          ...(worker.epoch === undefined ? {} : { epoch: worker.epoch }),
          ...(worker.revision === undefined ? {} : { revision: worker.revision }),
        }, AbortSignal.any([signal, AbortSignal.timeout(5_000)]))
        if (signal.aborted) return
        const feed = readAssistantNotificationFeed(raw)
        if (worker.epoch !== undefined && worker.epoch !== feed.epoch) worker.generation = this.nextGeneration(worker.node.hostId)
        const selected = new Set(worker.node.workspaceIds)
        const scoped: AssistantNotificationFeed = { ...feed,
          // 首次/缺口响应只能恢复当前待办；即使旧远端错误夹带历史终态也不重放。
          events: feed.baseline || feed.gap ? [] : feed.events.filter(fact => selected.has(fact.workspaceId) && supportsFact(feed, fact.kind)),
          pending: feed.capabilities.requests ? feed.pending.filter(fact => selected.has(fact.workspaceId)) : [],
        }
        const digest = JSON.stringify([feed.epoch, feed.revision, worker.node.hostLabel, scoped.pending, feed.capabilities])
        if (digest !== worker.digest || feed.events.length > 0 || feed.baseline || attempts > 0) {
          this.options.observer.onUpdate({ hostId: worker.node.hostId, hostLabel: worker.node.hostLabel, connectionGeneration: worker.generation, feed: scoped })
        }
        worker.epoch = feed.epoch; worker.revision = feed.revision; worker.digest = digest
        attempts = 0
      } catch (error) {
        if (signal.aborted) return
        worker.unsupported = isUnsupported(error)
        this.options.observer.onUnavailable(worker.node.hostId, worker.generation,
          worker.unsupported ? '该远端暂不支持会话提醒来源协议' : '远端暂不可达，提醒将在连接恢复后同步', worker.unsupported)
        if (worker.unsupported) return
        // 断线先撤销旧路由；重连即使逻辑请求相同，也需要新的可操作代次。
        worker.generation = this.nextGeneration(worker.node.hostId)
        attempts += 1
      }
      await wait(Math.min(30_000, this.interval() * 2 ** Math.min(attempts, 5)), signal)
    }
  }

  private nextGeneration(hostId: string): number {
    const value = (this.sequences.get(hostId) ?? 0) + 1
    this.sequences.set(hostId, value)
    return value
  }
  private interval(): number { return Math.max(10, this.options.intervalMs ?? 1000) }
}

function nodeKey(node: AssistantPeerNotificationNode): string {
  return JSON.stringify([node.capabilityKey, [...node.workspaceIds].sort()])
}
function supportsFact(feed: AssistantNotificationFeed, kind: AssistantNotificationFeed['events'][number]['kind']): boolean {
  if (kind === 'completed' || kind === 'error') return feed.capabilities[kind]
  return kind === 'resolved' ? feed.capabilities.resolve : feed.capabilities.requests
}
function isUnsupported(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const code = (value as { code?: unknown }).code
  return ['UNSUPPORTED_CAPABILITY', 'CODINGNS_RPC_NOT_FOUND', 'CODINGNS_RPC_UNSUPPORTED', 'PEER_HOST_UNSUPPORTED'].includes(String(code))
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    signal.addEventListener('abort', done, { once: true })
  })
}
