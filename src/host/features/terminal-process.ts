import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { TerminalLaunchProfileInput, TerminalProcessLaunchRequest } from '../../shared/contracts/terminal-process.js'
import { CodingNsRpcError } from '../rpc-table.js'
import type { CodingNsHostServices } from './types.js'

/** 为后续 Debug 面板提供终端 PTY 启动项和进程实例的 Host RPC。 */
export function createTerminalProcessFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'terminalProcess',
      version: '0.1.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    start(context) {
      const service = context.services.terminalProcesses
      context.resources.add(context.services.rpc.register('terminalProcess', (action, payload) => {
        if (service === undefined) throw new CodingNsRpcError('CODINGNS_TERMINAL_PROCESS_UNAVAILABLE', '终端进程服务未装配')
        switch (action) {
          case 'profile/list': {
            const input = optionalWorkspaceId(payload)
            return service.listProfiles(input)
          }
          case 'profile/create':
            return service.createProfile(parseProfileInput(payload))
          case 'profile/delete': {
            const input = objectFields(payload, ['workspaceId', 'profileId'])
            return service.deleteProfile(requiredString(input.workspaceId, 'workspaceId'), requiredString(input.profileId, 'profileId'))
          }
          case 'launch':
            return service.launch(parseLaunchRequest(payload))
          case 'runtime/list':
            return service.listInstances(optionalWorkspaceId(payload))
          case 'runtime/get':
            return service.getInstance(requiredString(objectFields(payload, ['instanceId']).instanceId, 'instanceId')) ?? null
          case 'runtime/stop':
            return service.stop(requiredString(objectFields(payload, ['instanceId']).instanceId, 'instanceId'))
          default:
            throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知终端进程 RPC: terminalProcess/${action}`)
        }
      }))
    },
  }
}

function parseProfileInput(value: unknown): TerminalLaunchProfileInput {
  const input = objectFields(value, ['id', 'workspaceId', 'name', 'cwdRelative', 'command', 'shell', 'runtimeType'])
  const shell = objectFields(input.shell, ['profileId', 'path', 'args', 'name'])
  if (!Array.isArray(shell.args) || shell.args.some((item) => typeof item !== 'string')) throw new TypeError('shell.args 无效')
  if (input.runtimeType !== 'local-pty' && input.runtimeType !== 'tmux' && input.runtimeType !== 'conpty-powershell' && input.runtimeType !== 'conpty-cmd' && input.runtimeType !== 'conpty-git-bash') throw new TypeError('runtimeType 无效')
  const args = input.args === undefined ? [] : input.args
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) throw new TypeError('args 无效')
  const env = input.env === undefined ? {} : input.env
  if (!isRecord(env) || Object.values(env).some((item) => typeof item !== 'string')) throw new TypeError('env 无效')
  return {
    id: requiredString(input.id, 'id'),
    workspaceId: requiredString(input.workspaceId, 'workspaceId'),
    name: requiredString(input.name, 'name'),
    cwdRelative: requiredString(input.cwdRelative, 'cwdRelative'),
    command: requiredString(input.command, 'command'),
    args,
    env,
    shell: {
      profileId: shell.profileId as TerminalLaunchProfileInput['shell']['profileId'],
      path: requiredString(shell.path, 'shell.path'),
      args: shell.args,
      name: requiredString(shell.name, 'shell.name'),
    },
    runtimeType: input.runtimeType,
    runtimeMode: 'pty',
  }
}

function parseLaunchRequest(value: unknown): TerminalProcessLaunchRequest {
  const input = objectFields(value, ['workspaceId', 'profileId', 'cols', 'rows'])
  return {
    workspaceId: requiredString(input.workspaceId, 'workspaceId'),
    profileId: requiredString(input.profileId, 'profileId'),
    ...(input.dshSessionId === undefined ? {} : { dshSessionId: requiredString(input.dshSessionId, 'dshSessionId') }),
    ...(input.terminalId === undefined ? {} : { terminalId: requiredString(input.terminalId, 'terminalId') }),
    cols: requiredInteger(input.cols, 'cols'),
    rows: requiredInteger(input.rows, 'rows'),
  }
}

function optionalWorkspaceId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  const input = objectFields(value, ['workspaceId'])
  return input.workspaceId === undefined ? undefined : requiredString(input.workspaceId, 'workspaceId')
}

function objectFields(value: unknown, fields: readonly string[]): Record<string, any> {
  if (!isRecord(value)) throw new TypeError('终端进程 RPC 参数必须是对象')
  for (const field of fields) if (!(field in value)) throw new TypeError(`终端进程 RPC 缺少字段: ${field}`)
  return value
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} 必须是非空字符串`)
  return value.trim()
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`${field} 必须是整数`)
  return value
}

function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
