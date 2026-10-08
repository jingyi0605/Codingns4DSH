import type { CodingNsCliAdapterId } from '../../shared/contracts/cli-adapter.js'

/** 当前插件注册的适配器；旧日志只能从这些稳定 ID 中选择，不能猜测任意品牌。 */
export const KNOWN_CLI_ADAPTER_IDS = new Set<CodingNsCliAdapterId>([
  'command-code',
  'claude-code',
  'codex',
  'gemini',
  'kimi',
  'pi',
  'opencode',
  'grok',
  'mcode',
  'zcode',
  'codebuddy',
  'workbuddy',
  'cursor-cli',
  'kiro-cli',
  'qoder',
  'qoder-cn',
  'antigravity',
  'doubao',
])

export interface LegacySessionAdapterEvidence {
  readonly sessionId: string
  readonly adapterId?: CodingNsCliAdapterId
  /** 分叉子会话的父会话；父会话已绑定外部适配器时，子会话必须继承。 */
  readonly parentSessionId?: string
  readonly seeded: boolean
  readonly cwd?: string
  readonly createdAt?: string
  readonly external: boolean
}

/** 普通 DSH 消息不影响外部来源判断；只在新增外部证据时重新检查旧会话。 */
export function hasLegacySessionAdapterHint(event: unknown): boolean {
  const record = asRecord(event)
  const data = asRecord(record?.data)
  const source = asRecord(asRecord(data?.message)?.source)
  if (source?.plugin === 'codingns4dsh' || source?.provider === 'codingns-external') return true
  const adapterId = firstString(source?.adapterId, record?.type === 'request/context' ? data?.adapterId ?? data?.provider : undefined)
  return adapterId !== undefined && (adapterId === 'codebuddy-cn' || KNOWN_CLI_ADAPTER_IDS.has(adapterId))
}

/**
 * 从 DSH 原生会话快照读取旧版外部 Agent 的适配器证据。
 *
 * 两级证据：
 * 1. 会话自身日志：`codingns-external` 只能证明消息来自外部 Agent；只有
 *    source/provider 或 request/context 中出现当前已知适配器 ID 时才回填，
 *    避免把 DSH 模型提供方误认成 CLI。
 * 2. 分叉继承：`isSeeded` 子会话自身可能没有任何插件痕迹——外部 Agent 只
 *    回了一段文本、没调工具时，日志里只有父会话继承下来的 request/context。
 *    此时由调用方按 `parentSessionId` 继承父会话已确认的绑定。
 */
export function inspectLegacySessionAdapter(value: unknown): LegacySessionAdapterEvidence | undefined {
  const record = asRecord(value)
  if (record === null) return undefined
  const header = asRecord(record.header)
  const sessionId = firstString(record.id, record.sessionId, header?.id)
  if (sessionId === undefined) return undefined

  const events = snapshotEvents(record)
  let external = false
  const candidates = new Set<CodingNsCliAdapterId>()
  for (const event of events) {
    const eventRecord = asRecord(event)
    if (eventRecord === null) continue
    const data = asRecord(eventRecord.data)
    const message = data === null ? null : asRecord(data.message)
    const source = message === null ? null : asRecord(message.source)
    const sourceProvider = firstString(source?.adapterId, source?.provider)
    const pluginSource = source?.plugin === 'codingns4dsh'
    if (sourceProvider === 'codingns-external' || pluginSource) external = true
    // 只有显式 adapterId 或插件自写的 source 才能作为来源证据；DSH 自己的
    // model provider 不能因为名字碰巧叫 codex 就被绑定到 Codex 适配器。
    addCandidate(candidates, firstString(source?.adapterId))
    if (pluginSource) addCandidate(candidates, sourceProvider)
    if (eventRecord.type === 'request/context') addCandidate(candidates, firstString(data?.adapterId, data?.provider))
  }
  const adapterId = external && candidates.size === 1 ? [...candidates][0] : undefined
  const parentSessionId = firstString(header?.parentSession)
  return {
    sessionId,
    ...(adapterId === undefined ? {} : { adapterId }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    seeded: header?.isSeeded === true,
    ...(typeof header?.cwd === 'string' && header.cwd.trim() ? { cwd: header.cwd.trim() } : {}),
    ...(typeof header?.createdAt === 'number' ? { createdAt: new Date(header.createdAt).toISOString() } : {}),
    ...(typeof header?.createdAt === 'string' && header.createdAt.trim() ? { createdAt: header.createdAt } : {}),
    external,
  }
}

function snapshotEvents(record: Record<string, unknown>): readonly unknown[] {
  const snapshot = record.snapshotEvents
  if (typeof snapshot === 'function') {
    try {
      const result = (snapshot as () => unknown)()
      if (Array.isArray(result)) return result
    } catch {
      // 单个损坏会话不能阻断其余会话迁移。
    }
  }
  return Array.isArray(record.events) ? record.events : []
}

function addCandidate(candidates: Set<string>, value: string | undefined): void {
  if (value === 'codebuddy-cn') {
    candidates.add('codebuddy')
    return
  }
  if (value !== undefined && KNOWN_CLI_ADAPTER_IDS.has(value)) candidates.add(value)
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
