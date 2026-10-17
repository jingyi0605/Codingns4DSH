import { randomBytes } from 'node:crypto'
import type { CodingNsTeamIdentity } from '../../shared/contracts/agent-team.js'

/**
 * 外部 CLI 子代理托管桥接的运行时句柄。
 *
 * Host 装配桥接服务后写入；驱动在拼参数/环境时读取。运行时不保存任何凭据到
 * 磁盘：token 与端口只存在于当前进程，并通过注入通道下发给外部 CLI 子进程。
 */

/** 一次被桥接接管的子代理调用结果，供驱动把 hook_blocked 投影为真实状态。 */
export interface SubagentBridgeRedirect {
  readonly childSessionId: string
  readonly ok: boolean
  /** 后台派发只表示已创建；必须保留 running，不能伪装成 completed。 */
  readonly completed?: boolean | undefined
  readonly status?: 'running' | 'completed' | 'failed' | 'interrupted' | undefined
  readonly toolCalls: number
}

export interface SubagentBridgeRuntime {
  readonly baseUrl: string
  readonly token: string
  /** 记录“某个工具调用已由 DSH 原生子代理完成”；按 toolCallId 去重。 */
  recordRedirect(sessionId: string, toolCallId: string, redirect: SubagentBridgeRedirect): void
  /** 取出并清理重定向记录；同一 toolCallId 只消费一次。 */
  consumeRedirect(sessionId: string, toolCallId: string): SubagentBridgeRedirect | undefined
  teamSession?(sessionId: string): { readonly token: string; readonly identity: CodingNsTeamIdentity } | undefined
  authorizeTeam?(token: string): string | undefined
  revokeTeamSession?(sessionId: string): void
  revokeTeamSessions?(): void
}

export interface TeamSessionAccess {
  readonly identity: CodingNsTeamIdentity
  readonly caller: object
  readonly signal: AbortSignal
}

const REDIRECT_TTL_MS = 30 * 60_000
const MAX_REDIRECTS = 1024

let current: SubagentBridgeRuntime | undefined

export function setSubagentBridge(runtime: SubagentBridgeRuntime | undefined): void {
  current = runtime
}

export function getSubagentBridge(): SubagentBridgeRuntime | undefined {
  return current
}

export function createSubagentBridgeRuntime(options: { readonly baseUrl: string; readonly token: string; readonly teamAccess?: (sessionId: string) => TeamSessionAccess | undefined }): SubagentBridgeRuntime {
  const redirects = new Map<string, { readonly redirect: SubagentBridgeRedirect; readonly expiresAt: number }>()
  const sessions = new Map<string, { token: string; access: TeamSessionAccess }>()
  const credentials = new Map<string, string>()
  const forget = (sessionId: string): void => {
    const previous = sessions.get(sessionId)
    if (previous) credentials.delete(previous.token)
    sessions.delete(sessionId)
  }
  const keyOf = (sessionId: string, toolCallId: string): string => `${sessionId}\u0000${toolCallId}`
  const prune = (now: number): void => {
    for (const [key, entry] of redirects) {
      if (entry.expiresAt <= now) redirects.delete(key)
    }
    if (redirects.size > MAX_REDIRECTS) {
      for (const key of [...redirects.keys()].slice(0, redirects.size - MAX_REDIRECTS)) redirects.delete(key)
    }
  }
  return {
    baseUrl: options.baseUrl,
    token: options.token,
    teamSession(sessionId) {
      const access = options.teamAccess?.(sessionId)
      if (!access || access.signal.aborted) { forget(sessionId); return undefined }
      let session = sessions.get(sessionId)
      if (session && (session.access.caller !== access.caller || session.access.signal !== access.signal || session.access.identity.teamId !== access.identity.teamId)) {
        forget(sessionId)
        session = undefined
      }
      if (!session) {
        for (const [id, candidate] of sessions) if (candidate.access.signal.aborted) forget(id)
        if (sessions.size >= 2048) {
          for (const [id, candidate] of sessions) {
            const live = options.teamAccess?.(id)
            if (!live || live.signal.aborted || live.caller !== candidate.access.caller || live.signal !== candidate.access.signal) forget(id)
          }
        }
        if (sessions.size >= 2048) return undefined
        session = { token: randomBytes(24).toString('hex'), access }
        sessions.set(sessionId, session)
        credentials.set(session.token, sessionId)
      }
      return { token: session.token, identity: access.identity }
    },
    authorizeTeam(token) {
      const sessionId = credentials.get(token)
      if (!sessionId) return undefined
      const previous = sessions.get(sessionId)
      const current = options.teamAccess?.(sessionId)
      if (!previous || !current || current.signal.aborted || previous.access.signal !== current.signal || previous.access.caller !== current.caller || previous.access.identity.teamId !== current.identity.teamId) {
        forget(sessionId)
        return undefined
      }
      return sessionId
    },
    revokeTeamSession: forget,
    revokeTeamSessions() { sessions.clear(); credentials.clear() },
    recordRedirect(sessionId, toolCallId, redirect) {
      if (sessionId === '' || toolCallId === '') return
      const now = Date.now()
      prune(now)
      redirects.set(keyOf(sessionId, toolCallId), { redirect, expiresAt: now + REDIRECT_TTL_MS })
    },
    consumeRedirect(sessionId, toolCallId) {
      if (sessionId === '' || toolCallId === '') return undefined
      const key = keyOf(sessionId, toolCallId)
      const entry = redirects.get(key)
      if (entry === undefined) return undefined
      redirects.delete(key)
      return entry.expiresAt <= Date.now() ? undefined : entry.redirect
    },
  }
}
