import type { InteractionAnswer, TranslatableQuestion } from './interaction-translation.js'

/** Internal presentation boundary. The owning DSH card retains all transport and wait state. */
export interface TranslationQuestionCard {
  readonly key: string
  readonly sessionId: string
  readonly kind: 'question' | 'plan-review'
  readonly questions: readonly TranslatableQuestion[]
  readonly callId?: string
  readonly review?: InteractionAnswer['answers']
  readonly dismissal: 'hide' | 'cancel'
  subscribe(listener: () => void): () => void
  snapshot(): {
    readonly closed: boolean
    readonly channel: 'waterfall' | 'rpc' | 'none'
    readonly state: 'open' | 'continued'
    readonly countdown?: { readonly remainingMs: number; readonly running: boolean } | undefined
  }
  answer(answer: InteractionAnswer): Promise<void>
  dismiss(): Promise<void>
  engage(): void
  takeTime(): void
  holdFocus(): void
  releaseFocus(): void
}

export interface TranslationTodo {
  readonly content: string
  readonly status: 'pending' | 'in_progress' | 'completed'
}
