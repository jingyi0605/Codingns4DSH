import type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliModelCatalog,
  CodingNsCliStreamChunk,
  CodingNsCliTurnInput,
  CodingNsCliPermissionResponse,
} from '../../shared/contracts/cli-adapter.js'

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
  executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsCliStreamChunk>
  respondPermission?(sessionId: string, response: CodingNsCliPermissionResponse): Promise<void> | void
  steer?(sessionId: string, prompt: string): Promise<void> | void
  followUp?(sessionId: string, prompt: string): Promise<void> | void
  interrupt?(sessionId: string): Promise<void> | void
  dispose?(): Promise<void> | void
}
