import type { CodingNsCliTeamDiagnostic } from '../../shared/contracts/cli-adapter.js'

/** DSH 0.2 原生 Agent Team 的最小结构契约。 */
export interface CodingNsNativeTeamProxy {
  diagnostic(): CodingNsCliTeamDiagnostic
  invoke(action: string, payload: unknown, signal?: AbortSignal): unknown | Promise<unknown>
}

export interface NativeTeamService {
  membership?: (agent: unknown) => unknown
  listMembers?: (agent: unknown) => unknown
  listTasks?: (agent: unknown) => unknown
  getTask?: (agent: unknown, id: unknown) => unknown
  spawnTeammate?: (agent: unknown, request: Record<string, unknown>) => unknown
  sendMessage?: (agent: unknown, request: Record<string, unknown>) => unknown
  createTask?: (agent: unknown, request: Record<string, unknown>) => unknown
  updateTask?: (agent: unknown, request: Record<string, unknown>) => unknown
  waitForChange?: (agent: unknown, timeoutMs: number, signal: AbortSignal) => unknown
  interrupt?: (agent: unknown, targetName: string) => unknown
}

export interface AgentRegistry {
  get?: (id: string) => unknown
  list?: () => readonly unknown[]
}

/**
 * 只负责 DSH 原生 TeamService 的调用边界，不把版本判断泄漏到业务模块。
 * 外部 CLI 没有 Agent 句柄，因此不会经过这个代理伪装成 Team 成员。
 */
export class DshNativeTeamProxy implements CodingNsNativeTeamProxy {
  constructor(
    private readonly service: NativeTeamService | undefined,
    private readonly agents: AgentRegistry | undefined,
  ) {}

  diagnostic(): CodingNsCliTeamDiagnostic {
    const supported = this.service !== undefined
      && typeof this.service.listMembers === 'function'
      && typeof this.service.spawnTeammate === 'function'
      && this.findAnyAgent() !== undefined
    return supported
      ? {
          supported: true,
          code: 'DSH_TEAM_PROXY_READY',
          message: 'DSH 0.2 原生 Agent Team 已通过 Codingns4DSH Proxy 暴露。',
        }
      : {
          supported: false,
          code: 'DSH_TEAM_NATIVE_UNAVAILABLE',
          message: '当前 DSH 未注入可用的原生 Agent Team 或 Agent 注册表。',
        }
  }

  invoke(action: string, payload: unknown, signal = new AbortController().signal): unknown | Promise<unknown> {
    const service = this.service
    if (service === undefined) throw new Error('DSH_TEAM_NATIVE_UNAVAILABLE')
    const input = asRecord(payload)
    const agent = this.findAgent(readString(input, 'sessionId'))
    if (agent === undefined) throw new Error('DSH_TEAM_AGENT_NOT_FOUND')
    switch (action) {
      case 'status':
        return {
          ...this.diagnostic(),
          membership: call(service.membership, service, agent),
          members: call(service.listMembers, service, agent),
        }
      case 'members': return requiredCall(service.listMembers, service, agent)
      case 'tasks': return requiredCall(service.listTasks, service, agent)
      case 'task': return requiredCall(service.getTask, service, agent, readRequired(input, 'taskId'))
      case 'spawn': return requiredCall(service.spawnTeammate, service, agent, withSignal(input, signal))
      case 'message': return requiredCall(service.sendMessage, service, agent, withSignal(input, signal))
      case 'task/create': return requiredCall(service.createTask, service, agent, input)
      case 'task/update': return requiredCall(service.updateTask, service, agent, input)
      case 'wait': return requiredCall(service.waitForChange, service, agent, readNumber(input, 'timeoutMs', 30_000), signal)
      case 'interrupt': return requiredCall(service.interrupt, service, agent, readRequired(input, 'targetName'))
      default: throw new Error(`DSH_TEAM_RPC_NOT_FOUND: team/${action}`)
    }
  }

  private findAgent(sessionId: string): unknown {
    if (this.agents === undefined) return undefined
    if (sessionId !== '' && typeof this.agents.get === 'function') {
      const direct = this.agents.get(sessionId)
      if (direct !== undefined) return direct
    }
    for (const candidate of this.agents.list?.() ?? []) {
      const session = readUnknown(candidate, 'session')
      if (readUnknown(session, 'id') === sessionId || readUnknown(candidate, 'id') === sessionId) return candidate
    }
    return undefined
  }

  private findAnyAgent(): unknown {
    return this.agents?.list?.()[0]
  }
}

// 官方 TeamService 的方法依赖 this（例如 spawnTeammate 第一行读 this.roster），
// 从服务对象上取出方法后解绑调用会抛 "Cannot read properties of undefined
// (reading 'roster')"。必须用 apply 保留 owner。
function call(fn: ((...args: any[]) => unknown) | undefined, owner: NativeTeamService | undefined, ...args: unknown[]): unknown {
  return typeof fn === 'function' ? fn.apply(owner, args) : undefined
}

function requiredCall(fn: ((...args: any[]) => unknown) | undefined, owner: NativeTeamService | undefined, ...args: unknown[]): unknown {
  if (typeof fn !== 'function') throw new Error('DSH_TEAM_OPERATION_UNAVAILABLE')
  return fn.apply(owner, args)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return { ...(value as Record<string, unknown>) }
}

function readUnknown(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function readString(value: Record<string, unknown>, key: string): string {
  const result = value[key]
  return typeof result === 'string' ? result.trim() : ''
}

function readRequired(value: Record<string, unknown>, key: string): string {
  const result = readString(value, key)
  if (result === '') throw new Error(`DSH_TEAM_INVALID_${key.toUpperCase()}`)
  return result
}

function readNumber(value: Record<string, unknown>, key: string, fallback: number): number {
  const result = value[key]
  return typeof result === 'number' && Number.isSafeInteger(result) && result >= 0 ? result : fallback
}

function withSignal(value: Record<string, unknown>, signal: AbortSignal): Record<string, unknown> {
  return { ...value, signal }
}
