import type { CodingNsRpcTable } from './rpc-table.js'
import type { DshGatewayFeature, DshStreamContext } from '../transport/dsh-gateway.js'

/** 将 Host 已登记的 RPC 命名空间接到 DSH Gateway。 */
export function createDshRpcGatewayFeature(rpc: CodingNsRpcTable): DshGatewayFeature {
  return {
    channel: 'rpc',
    operation: 'rpc.request',
    handleStream: async (context) => {
      try {
        const request = readJson(context)
        if (!isRecord(request) || typeof request.method !== 'string' || request.method.trim() === '') {
          throw new DshGatewayRequestError('MESSAGE_INVALID', 'DSH RPC 请求缺少 method')
        }
        const target = rpc.resolve(request.method)
        if (target === null) throw new DshGatewayRequestError('FEATURE_DISABLED', 'DSH RPC 未启用')
        const value = await target.handler(target.action, request.payload)
        context.send('rpc.response', { encoding: 'json' }, encodeJson(value))
      } catch (error) {
        // 业务异常可能包含命令行、路径或凭据片段，跨隧道只返回稳定的短描述。
        const detail = error instanceof DshGatewayRequestError ? error.message : 'DSH RPC 执行失败'
        const errorCode = error instanceof DshGatewayRequestError ? error.code : 'DSH_RPC_FAILED'
        context.send('stream.error', { errorCode, detail, retryable: false })
      } finally {
        context.close()
      }
    },
  }
}

function readJson(context: DshStreamContext): unknown {
  const body = context.envelope.body
  if (body === undefined || context.envelope.meta.encoding !== 'json') return undefined
  try { return JSON.parse(new TextDecoder().decode(body)) as unknown } catch { throw new DshGatewayRequestError('MESSAGE_INVALID', 'DSH RPC 请求正文不是有效 JSON') }
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value === undefined ? null : value))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class DshGatewayRequestError extends Error {
  constructor(readonly code: 'MESSAGE_INVALID' | 'FEATURE_DISABLED', message: string) { super(message); this.name = code }
}
