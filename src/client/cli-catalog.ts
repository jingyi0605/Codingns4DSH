import type { CodingNsCliAdapterDescriptor, CodingNsCliModel, CodingNsCliModelCatalog } from '../shared/contracts/cli-adapter.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsRpcClient } from './features/types.js'

/** Client 侧访问 Host CLI 命名空间的统一入口。 */
export async function callCliRpc<T>(rpc: CodingNsRpcClient, action: string, payload: unknown): Promise<T> {
  let response
  try {
    response = await rpc.call(CODINGNS_RPC_CHANNEL, `cli/${action}`, payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/HTTP (?:404|405)\b/u.test(message)) throw error
    response = await rpc.call('/api', `codingns/cli/${action}`, payload)
  }
  if (!response.ok) throw new Error(response.error.message)
  return response.value as T
}

export function adapterCatalogWithDsh(catalog: readonly CodingNsCliAdapterDescriptor[]): CodingNsCliAdapterDescriptor[] {
  return [{ id: 'dsh', name: 'DeepSeek Harness', installed: true, enabled: true, version: null, command: null }, ...catalog]
}

export function firstModel(catalog: CodingNsCliModelCatalog): CodingNsCliModel | undefined {
  for (const group of catalog.groups) {
    const model = group.models[0]
    if (model !== undefined) return model
  }
  return undefined
}

export function findModel(catalog: CodingNsCliModelCatalog, modelId: string | undefined): CodingNsCliModel | undefined {
  if (modelId === undefined) return undefined
  for (const group of catalog.groups) {
    const model = group.models.find((item) => item.id === modelId)
    if (model !== undefined) return model
  }
  return undefined
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
