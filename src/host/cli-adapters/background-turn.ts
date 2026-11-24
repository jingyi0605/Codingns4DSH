import type { CodingNsCliMessage } from '../../shared/contracts/cli-adapter.js'
import { randomUUID } from 'node:crypto'

/** Host-owned control input. It consumes existing output; it is never a prompt. */
export const EXTERNAL_TURN_SOURCE = 'codingns-external-turn'
export interface CodingNsBackgroundTurn {
  readonly sessionId: string
  readonly providerSessionId: string
  readonly turnId: string
}

export function externalTurnMessage(turn: CodingNsBackgroundTurn) {
  return {
    id: `codingns-external-turn-${randomUUID()}`,
    role: 'user' as const,
    content: [{ type: 'text' as const, text: '工作流执行结果' }],
    source: { kind: EXTERNAL_TURN_SOURCE, form: 'notice', summary: '工作流执行结果',
      externalTurnId: turn.turnId, providerSessionId: turn.providerSessionId },
  }
}

/** Only examine this step's input, never an earlier already-consumed notice. */
export function readExternalTurn(messages: readonly CodingNsCliMessage[]): { turnId: string; providerSessionId: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    const s = m.source as Record<string, unknown> | undefined
    if (s?.kind === EXTERNAL_TURN_SOURCE && typeof s.externalTurnId === 'string' && typeof s.providerSessionId === 'string') {
      return { turnId: s.externalTurnId, providerSessionId: s.providerSessionId }
    }
    if (!s?.kind || s.kind === 'user') return undefined
  }
  return undefined
}

/** Derive acknowledgements from the same durable native log as the actual replies. */
export function externalTurnSyncState(events: readonly unknown[]) {
  const delivered = new Set<string>(), pending = new Set<string>(), suppressed = new Set<string>(), texts: string[] = []
  // 每个身份被投递过几次。失败结束（error）既不算 delivered 也不算 suppressed，
  // 恢复逻辑会把同一条结果反复注入；调用方用这个计数给重试设上限。
  const attempts = new Map<string, number>()
  const inbox: Record<string, unknown[]> = { 'next-turn': [], 'next-step': [] }
  let current = '', currentProvider = '', replied = false
  const identity = (source: any) => JSON.stringify([source?.providerSessionId, source?.externalTurnId])
  for (const raw of events) {
    const e = raw as any, d = e?.data
    if (e?.type === 'turn/start') { current = ''; currentProvider = ''; replied = false }
    if (e?.type === 'agent/inbox/spliced' && inbox[d?.target]) inbox[d.target]!.splice(d.start, d.removedCount ?? 0, ...(d.inserted ?? []))
    if (e?.type === 'user/message' && d?.source?.kind === EXTERNAL_TURN_SOURCE) {
      current = identity(d.source); currentProvider = d.source.providerSessionId
      attempts.set(current, (attempts.get(current) ?? 0) + 1)
    }
    if (e?.type === 'assistant/message') {
      const t = (d?.message?.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text ?? '').join('')
      if (t) { texts.push(t); replied = true }
    }
    if (e?.type === 'turn/end') {
      if (current && currentProvider && replied && d?.reason?.kind === 'completed') delivered.add(current)
      if (current && d?.reason?.kind === 'aborted' && d?.reason?.reason?.kind === 'user') suppressed.add(current)
      current = ''; replied = false
    }
  }
  if (current) pending.add(current)
  for (const messages of Object.values(inbox)) for (const raw of messages) {
    const m = raw as any
    if (m?.source?.kind === EXTERNAL_TURN_SOURCE) pending.add(identity(m.source))
  }
  return { delivered, pending, suppressed, texts, attempts }
}
