import type { CodingNsCliMessage } from '../../shared/contracts/cli-adapter.js'

export function isTeamPeerMessage(message: CodingNsCliMessage): boolean {
  return message.role === 'user' && (message.source?.kind === 'team-message'
    || message.source?.kind === 'agent-message' && message.source.form === 'relay')
}

/** Native completion notices carry a child's final result or failure. */
export function isTeamInputMessage(message: CodingNsCliMessage): boolean {
  return isTeamPeerMessage(message) || message.role === 'user' && message.source?.kind === 'subagent-settled'
    && message.source.form === 'notice' && typeof message.source.senderSessionId === 'string'
}

/** Manual LLM consumers have no inbox hook: only consider input after the last assistant. */
export function pendingPeerInput(messages: readonly CodingNsCliMessage[]): readonly CodingNsCliMessage[] {
  let boundary = messages.length - 1
  while (boundary >= 0 && messages[boundary]?.role !== 'assistant') boundary -= 1
  const tail = messages.slice(boundary + 1)
  if (!tail.some(isTeamInputMessage)) return []
  return tail.filter(message => isTeamInputMessage(message) || message.role === 'user'
    && (message.source === undefined || message.source.kind === undefined || message.source.kind === 'user'))
}

/** Native pre-step acceptance, rather than reconstructed history, owns live input selection. */
export class TeamInputTracker {
  private readonly pending = new Map<string, readonly CodingNsCliMessage[]>()
  private readonly observed = new Set<string>()
  private readonly consumed = new Map<string, Set<string>>()

  accept(sessionId: string, messages: readonly CodingNsCliMessage[]): void {
    if (!sessionId) return
    this.observed.add(sessionId)
    const relevant = messages.filter(message => isTeamInputMessage(message) || message.role === 'user'
      && (message.source === undefined || message.source.kind === undefined || message.source.kind === 'user'))
    const previous = this.pending.get(sessionId) ?? []
    const combined = [...previous]
    for (const message of relevant) {
      if (!combined.some(item => item === message || item.id !== undefined && item.id === message.id)) combined.push(message)
    }
    if (combined.length > 0) this.pending.set(sessionId, combined)
  }

  take(sessionId: string, history: readonly CodingNsCliMessage[]): readonly CodingNsCliMessage[] {
    const accepted = this.pending.get(sessionId)
    this.pending.delete(sessionId)
    if (accepted?.some(isTeamInputMessage)) {
      const consumed = this.consumed.get(sessionId) ?? new Set<string>()
      for (const message of accepted) if (message.id) consumed.add(message.id)
      while (consumed.size > 2048) consumed.delete(consumed.values().next().value!)
      this.consumed.set(sessionId, consumed)
      return accepted
    }
    if (accepted?.length) return []
    if (this.observed.has(sessionId)) {
      if (pendingPeerInput(history).some(message => isTeamInputMessage(message) && (!message.id || !this.consumed.get(sessionId)?.has(message.id)))) {
        throw Object.assign(new Error('A previous Team input has uncertain provider delivery. Inspect the session before explicitly resending it.'), { code: 'TEAM_DELIVERY_UNCERTAIN' })
      }
      return []
    }
    return pendingPeerInput(history)
  }

  release(sessionId: string): void { this.pending.delete(sessionId); this.observed.delete(sessionId); this.consumed.delete(sessionId) }
  clear(): void { this.pending.clear(); this.observed.clear(); this.consumed.clear() }
}
