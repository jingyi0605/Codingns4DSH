/** CodingNS 当前可接入的外部 Agent 标识。内部字段沿用 cli 命名以保持协议兼容。 */
export type CodingNsCliAdapterId = string

/** Host 侧可供 Client 展示的外部 Agent 摘要。 */
export interface CodingNsCliAdapterDescriptor {
  readonly id: CodingNsCliAdapterId
  readonly name: string
  /** 适配器使用的标准运行时协议，供设置页和诊断显示。 */
  readonly protocol?: 'command' | 'stream-json' | 'json-rpc' | 'acp' | 'http-sse'
  /** 适配器已经验证的能力；未声明的能力必须按不支持处理。 */
  readonly capabilities?: readonly CodingNsCliCapability[]
  readonly installed: boolean
  readonly enabled: boolean
  readonly version: string | null
  readonly command: string | null
}

export type CodingNsCliCapability =
  | 'models'
  | 'stream'
  | 'resume'
  | 'interrupt'
  | 'tool-events'
  | 'reasoning'
  | 'usage'
  | 'permission'
  | 'steer'

/** 适配器模型及其可用思考强度。 */
export interface CodingNsCliModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly efforts: readonly string[]
}

export interface CodingNsCliModelGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly CodingNsCliModel[]
}

export interface CodingNsCliModelCatalog {
  readonly groups: readonly CodingNsCliModelGroup[]
  readonly currentModel: string | null
  readonly currentEffort: string | null
}

/** 每个 DSH 会话绑定的 CLI 选择；不包含凭据。 */
export interface CodingNsCliSessionConfig {
  readonly adapterId: CodingNsCliAdapterId
  readonly modelId?: string
  readonly effortId?: string
  /** 外部运行时会话标识，只保存在 Host 会话表中。 */
  readonly providerSessionId?: string
  readonly rawStoreRef?: string
}

/** 外部 Agent 会话在 Host 侧的持久化索引。
 *
 * 这里只保存恢复会话所需的标识和摘要，不保存令牌、原始消息或进程句柄。
 * dshSessionId 仍然是 DSH 的会话主键，providerSessionId 只由 Host 使用。
 */
export type CodingNsCliSessionStatus = 'active' | 'idle' | 'error' | 'archived'

export interface CodingNsCliSessionRecord extends CodingNsCliSessionConfig {
  readonly dshSessionId: string
  readonly title?: string
  readonly cwd?: string
  readonly status: CodingNsCliSessionStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastError?: string
}

/** 传给 CLI 驱动的一轮完整上下文。 */
export interface CodingNsCliTurnInput {
  readonly sessionId: string
  readonly messages: readonly CodingNsCliMessage[]
  readonly prompt: string
  readonly modelId?: string
  readonly effortId?: string
  readonly cwd?: string
  readonly signal?: AbortSignal
  readonly providerSessionId?: string
  readonly rawStoreRef?: string
}

export interface CodingNsCliPermissionResponse {
  readonly requestId: string
  readonly approved: boolean
  readonly reason?: string
}

export interface CodingNsCliMessage {
  readonly id?: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly content: unknown
}

export type CodingNsCliStreamChunk =
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'text-delta'; readonly text: string }
  | {
      readonly type: 'tool-running'
      readonly toolName: string
      readonly status?: 'started' | 'running' | 'completed' | 'failed'
      readonly callId?: string
      readonly input?: string
      readonly output?: string
      readonly error?: string
      readonly agentId?: string
      readonly detail?: string
    }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'cancel' | 'error' }
  | { readonly type: 'session-binding'; readonly providerSessionId: string; readonly rawStoreRef?: string }
  | { readonly type: 'permission-request'; readonly requestId: string; readonly kind: string; readonly detail?: string }
