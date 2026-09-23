import type { FeatureModule } from '../../shared/contracts/feature.js'
import { CodingNsRpcError } from '../rpc-table.js'
import type { CodingNsHostServices } from './types.js'

/** Spec003 Host RPC：只承载配置、PTY、端口检查和已有代理绑定。 */
export function createDebugFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'debug',
      version: '0.1.0',
      enabledByDefault: true,
      dependencies: ['terminalProcess'],
      runtime: 'host',
    },
    start(context) {
      const service = context.services.debug
      if (service === undefined) throw new CodingNsRpcError('CODINGNS_DEBUG_UNAVAILABLE', 'Spec003 调试服务未装配')
      context.resources.add(context.services.rpc.register('debug', async (action, payload) => {
        const input = objectFields(payload)
        const workspaceId = requiredString(input.workspaceId, 'workspaceId')
        requiredString(input.sessionId, 'sessionId')
        generation(input.generation)
        switch (action) {
          case 'config/get':
            return service.getConfig(workspaceId)
          case 'config/save':
            return service.saveConfig(workspaceId, input.config)
          case 'profile/list':
            return (await service.getConfig(workspaceId)).profiles
          case 'profile/launch':
            return service.launch({ workspaceId, profileId: requiredString(input.profileId, 'profileId'), ...(input.dshSessionId === undefined ? {} : { dshSessionId: requiredString(input.dshSessionId, 'dshSessionId') }), cols: integer(input.cols, 'cols'), rows: integer(input.rows, 'rows') })
          case 'runtime/get':
            return scopedInstance(service.getInstance(requiredString(input.instanceId, 'instanceId')), workspaceId)
          case 'runtime/list':
            return service.listInstances(workspaceId)
          case 'runtime/stop':
            scopedInstance(service.getInstance(requiredString(input.instanceId, 'instanceId')), workspaceId)
            return service.stop(requiredString(input.instanceId, 'instanceId'))
          case 'port/check':
            return service.checkPort(workspaceId, requiredString(input.profileId, 'profileId'))
          case 'port/terminate':
            return service.terminatePort(workspaceId, requiredString(input.checkId, 'checkId'))
          case 'proxy/get':
            return service.getProxy(requiredString(input.bindingId, 'bindingId'))
          case 'proxy/enable':
            return service.enableProxy(workspaceId, requiredString(input.profileId, 'profileId'), requiredString(input.instanceId, 'instanceId'))
          case 'proxy/disable':
            return service.disableProxy(workspaceId, requiredString(input.bindingId, 'bindingId'))
          default:
            throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 Spec003 RPC: debug/${action}`)
        }
      }))
    },
  }
}

function objectFields(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Spec003 RPC 参数必须是对象')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} 必须是非空字符串`)
  return value.trim()
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} 必须是正整数`)
  return value
}

function generation(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('generation 必须是非负整数')
  return value
}

function scopedInstance<T extends { readonly workspaceId: string }>(instance: T | undefined, workspaceId: string): T | null {
  if (instance === undefined) return null
  if (instance.workspaceId !== workspaceId) throw new Error('运行实例不属于当前 Workspace')
  return instance
}
