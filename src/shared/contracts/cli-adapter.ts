/** CodingNS 当前可接入的外部 Agent 标识。内部字段沿用 cli 命名以保持协议兼容。 */
export type CodingNsCliAdapterId = string

/** Host 侧可供 Client 展示的外部 Agent 摘要。 */
export interface CodingNsCliAdapterDescriptor {
  readonly id: CodingNsCliAdapterId
  readonly name: string
  readonly installed: boolean
  readonly enabled: boolean
  readonly version: string | null
  readonly command: string | null
}

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
}

export interface CodingNsCliMessage {
  readonly id?: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly content: unknown
}

export type CodingNsCliStreamChunk =
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'tool-running'; readonly toolName: string }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly type: 'finish'; readonly reason: 'stop' | 'cancel' | 'error' }
