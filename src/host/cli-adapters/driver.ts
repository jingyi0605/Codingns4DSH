import type {
  CodingNsCliAdapterDescriptor,
  CodingNsAgentEvent,
  CodingNsAgentQuestionResponse,
  CodingNsCliModelCatalog,
  CodingNsCliTurnInput,
  CodingNsAgentPermissionResponse,
} from '../../shared/contracts/cli-adapter.js'

/** 外部 Provider 原始会话的只读存在性状态。 */
export type CodingNsCliSessionProbeState =
  | 'available'
  | 'missing'
  | 'corrupt'
  | 'unreachable'
  | 'unknown'
  | 'ephemeral'

/**
 * 会话探测只接收恢复所需的 Host 私有索引，不得通过 resume/load/prompt 探测，
 * 因为这些协议调用可能修改 Provider 状态或意外创建新会话。
 */
export interface CodingNsCliSessionProbeInput {
  readonly providerSessionId?: string
  readonly rawStoreRef?: string
  readonly cwd?: string
  /** 由 Registry 的探测超时控制器提供；网络型驱动应向下传递。 */
  readonly signal?: AbortSignal
}

export interface CodingNsCliSessionProbeResult {
  readonly state: CodingNsCliSessionProbeState
  readonly reason: string
  /** 探测确认的原始存储位置，只能留在 Host。 */
  readonly rawStoreRef?: string
}

/**
 * Host 内部的标准 Agent 运行时边界。
 *
 * 各适配器可以使用自己的 CLI、JSON-RPC、ACP 或 HTTP/SSE 协议，但对上层只返回
 * 统一的模型目录、会话绑定、文本/推理/工具/用量/完成事件。凭据、原始协议和
 * 进程句柄永远留在 Host 侧，Client 只消费 descriptor 与标准流。
 */
export interface CodingNsCliDriver {
  readonly descriptor: Omit<CodingNsCliAdapterDescriptor, 'installed' | 'enabled' | 'version' | 'command'>
  detect(): Promise<Pick<CodingNsCliAdapterDescriptor, 'installed' | 'version' | 'command'>>
  listModels(): Promise<CodingNsCliModelCatalog>
  probeSession?(input: CodingNsCliSessionProbeInput): Promise<CodingNsCliSessionProbeResult>
  executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsAgentEvent>
  respondPermission?(sessionId: string, response: CodingNsAgentPermissionResponse): Promise<void> | void
  respondQuestion?(sessionId: string, response: CodingNsAgentQuestionResponse): Promise<void> | void
  steer?(sessionId: string, prompt: string): Promise<void> | void
  followUp?(sessionId: string, prompt: string): Promise<void> | void
  interrupt?(sessionId: string): Promise<void> | void
  dispose?(): Promise<void> | void
}
