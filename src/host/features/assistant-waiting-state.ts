import type { AssistantWaitingKind } from '../../shared/contracts/assistant.js'

export interface AssistantWaitingRequest {
  readonly sessionId: string
  readonly kind: AssistantWaitingKind
}
/** 只消费运行时审批/提问事件，不从 running 状态或历史日志猜测等待。 */
export class AssistantWaitingState {
  private readonly pending = new Map<string, AssistantWaitingKind>()

  request(value: AssistantWaitingRequest): void {
    this.pending.set(value.sessionId, value.kind)
  }

  resolve(sessionId: string): void {
    this.pending.delete(sessionId)
  }

  get(sessionId: string): AssistantWaitingKind | null {
    return this.pending.get(sessionId) ?? null
  }

  snapshot(): ReadonlyMap<string, AssistantWaitingKind> {
    return new Map(this.pending)
  }
}
