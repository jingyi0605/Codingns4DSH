import type { AggregateHostResult, AggregateWorkspaceSummary, PeerHostSessionRecord } from '../../../shared/contracts/peer-host.js'

export interface AggregateSessionSource {
  readonly sessionId: string
  readonly title: string
  readonly status: string
  readonly updatedAt: number
  /** DSH 原生会话是否仍处于待首条消息的临时状态。 */
  readonly blank: boolean
  readonly adapterId?: string
}

export interface AggregateWorkspaceSource {
  readonly workspaceId: string
  readonly displayName: string
  /** 工作区在所属 Host 上的真实路径；原生文件面板按路径解析，不能用 workspaceId 代替。 */
  readonly path: string
  readonly sessions: readonly AggregateSessionSource[]
  /** 已归档会话；远端侧栏默认隐藏，但归档入口与取消归档路由需要它们。 */
  readonly archivedSessions?: readonly AggregateSessionSource[]
}

export interface AggregateHostSource {
  readonly hostId: string
  readonly targetHostId: string | null
  readonly hostLabel: string
  /** 该 Host 工作区标签的配色；缺省时客户端按名称推导稳定色。 */
  readonly hostColor?: string | null
  readonly load: () => Promise<readonly AggregateWorkspaceSource[]>
  /** DSH 未提供稳定摘要来源时显式声明降级，不把失败折叠成空数组。 */
  readonly capability?: {
    readonly available: boolean
    readonly reason: string
  }
}

/**
 * 当前 Host 的 workspace/session 摘要来源契约。
 *
 * DSH 版本之间的 SessionStore/WorkspaceController 不是稳定公共 API，聚合层
 * 不直接读取未知对象。Host 只有在完成结构探测后，才能注入这个 source。
 */
export interface PeerHostWorkspaceSessionSummarySource {
  readonly capabilityId: 'peer-host.native-workspace-session-summary'
  readonly available: boolean
  readonly reason?: string
  load(signal?: AbortSignal): Promise<readonly AggregateWorkspaceSource[]>
}

/** 将显式 source 转为聚合任务；不可用 source 保留 unsupported 诊断。 */
export function createAggregateHostSource(input: {
  readonly hostId: string
  readonly targetHostId: string | null
  readonly hostLabel: string
  readonly hostColor?: string | null
  readonly source: PeerHostWorkspaceSessionSummarySource
}): AggregateHostSource {
  const source = input.source
  return {
    hostId: input.hostId,
    targetHostId: input.targetHostId,
    hostLabel: input.hostLabel,
    ...(input.hostColor === undefined ? {} : { hostColor: input.hostColor }),
    capability: {
      available: source.available,
      reason: source.reason?.trim() || (source.available ? '摘要 source 已就绪' : 'Host 未提供稳定 workspace/session 摘要 source'),
    },
    load: () => source.load(),
  }
}

/** 并发加载多 Host 摘要；单个目标失败只生成该 Host 的错误节点。 */
export class PeerHostAggregateService {
  constructor(private readonly timeoutMs = 5_000) {}

  async load(sources: readonly AggregateHostSource[]): Promise<readonly AggregateHostResult[]> {
    return Promise.all(sources.map((source) => this.loadOne(source)))
  }

  private async loadOne(source: AggregateHostSource): Promise<AggregateHostResult> {
    if (source.capability?.available === false) {
      return {
        hostId: source.hostId,
        targetHostId: source.targetHostId,
        hostLabel: source.hostLabel,
        hostColor: source.hostColor ?? null,
        availability: 'unsupported',
        errorCode: null,
        diagnostic: source.capability.reason,
        workspaces: [],
      }
    }
    try {
      const workspaces = await withTimeout(source.load(), this.timeoutMs)
      return {
        hostId: source.hostId,
        targetHostId: source.targetHostId,
        hostLabel: source.hostLabel,
        hostColor: source.hostColor ?? null,
        availability: 'ready',
        errorCode: null,
        workspaces: workspaces.map((workspace) => toWorkspace(source, workspace)),
      }
    } catch (error) {
      return {
        hostId: source.hostId,
        targetHostId: source.targetHostId,
        hostLabel: source.hostLabel,
        hostColor: source.hostColor ?? null,
        availability: 'unreachable',
        errorCode: 'PEER_HOST_UNREACHABLE',
        workspaces: [],
      }
    }
  }
}

function toWorkspace(source: AggregateHostSource, workspace: AggregateWorkspaceSource): AggregateWorkspaceSummary {
  const archivedSessions = workspace.archivedSessions ?? []
  return {
    key: `${source.hostId}:${workspace.workspaceId}`,
    hostId: source.hostId,
    targetHostId: source.targetHostId,
    workspaceId: workspace.workspaceId,
    displayName: workspace.displayName,
    path: workspace.path,
    hostLabel: source.hostLabel,
    availability: 'ready',
    sessions: workspace.sessions.map((session) => toSessionRecord(source, workspace, session)),
    ...(archivedSessions.length === 0
      ? {}
      : { archivedSessions: archivedSessions.map((session) => toSessionRecord(source, workspace, session)) }),
  }
}

function toSessionRecord(
  source: AggregateHostSource,
  workspace: AggregateWorkspaceSource,
  session: AggregateSessionSource,
): PeerHostSessionRecord {
  return {
    scope: {
      hostId: source.hostId,
      targetHostId: source.targetHostId,
      workspaceId: workspace.workspaceId,
      sessionId: session.sessionId,
      scopeGeneration: 0,
    },
    title: session.title,
    status: session.status,
    updatedAt: session.updatedAt,
    // 旧摘要 source 可能没有该字段；缺省按正式会话兼容，远端原生 source 会提供真实值。
    blank: session.blank === true,
    ...(session.adapterId === undefined ? {} : { adapterId: session.adapterId }),
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('摘要超时时间必须为正数')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('PeerHost 摘要超时')), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
