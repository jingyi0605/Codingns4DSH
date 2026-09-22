import type {
  CodingNsCliAdapterDescriptor,
  CodingNsCliModelCatalog,
  CodingNsCliStreamChunk,
  CodingNsCliTurnInput,
} from '../../shared/contracts/cli-adapter.js'

/** 一个 CLI 驱动必须实现的最小边界。驱动内部可以使用各自 CLI 的私有协议。 */
export interface CodingNsCliDriver {
  readonly descriptor: Omit<CodingNsCliAdapterDescriptor, 'installed' | 'enabled' | 'version' | 'command'>
  detect(): Promise<Pick<CodingNsCliAdapterDescriptor, 'installed' | 'version' | 'command'>>
  listModels(): Promise<CodingNsCliModelCatalog>
  executeTurn(input: CodingNsCliTurnInput): AsyncIterable<CodingNsCliStreamChunk>
  dispose?(): Promise<void> | void
}
