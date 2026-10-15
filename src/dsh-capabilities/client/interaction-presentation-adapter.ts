import type { ComponentType, ReactElement } from 'react'
import type { TranslationQuestionCard, TranslationTodo } from '../../shared/contracts/interaction-presentation.js'
import type { InteractionTranslationField, InteractionTranslationResult } from '../../shared/contracts/interaction-translation.js'
import { displayQuestionHistory, questionHistoryFields, readQuestionHistory } from './question-history-adapter.js'
import { followPresentationEntry, mirrorPresentationSlot, type PresentationSlots, type RenderElement } from './slot-presentation-mirror.js'

export interface QuestionPresentation {
  readonly matched: TranslationQuestionCard
  render(card: TranslationQuestionCard): ReactElement
}
export interface QuestionHistoryPresentation {
  readonly sessionId: string
  readonly fields: readonly InteractionTranslationField[]
  render(result: InteractionTranslationResult): ReactElement
}

export interface InteractionPresentationBridge {
  coordinator(component: ComponentType<{ sessionId: string }>): () => void
  questions(sessionId: string, component: ComponentType<QuestionPresentation>, element: RenderElement): () => void
  todos(render: (props: { sessionId: string; todos: readonly TranslationTodo[]; original: ReactElement }) => ReactElement, element: RenderElement): () => void
  questionHistory(render: (props: QuestionHistoryPresentation) => ReactElement, element: RenderElement): () => void
}

export function supportsInteractionPresentation(context: unknown): boolean {
  const slots = (context as { slots?: Partial<PresentationSlots> } | undefined)?.slots
  return typeof slots?.inject === 'function' && typeof slots.register === 'function' && typeof slots.entries === 'function' && typeof slots.subscribe === 'function'
}

/** Only the pinned Slot and PendingQuestion ABI is interpreted here. */
export function createInteractionPresentationBridge(context: unknown): InteractionPresentationBridge {
  const slots = (context as { slots: PresentationSlots }).slots
  return {
    coordinator(component) {
      return slots.inject('conversation.input.left', () => slots.register({
        name: 'conversation.input.left', id: 'codingns-interaction-translation', order: 100,
      }, component))
    },
    questions(sessionId, component, element) {
      const actionSlot = `codingns.translation.plan-actions.${encodeURIComponent(sessionId)}`
      return followPresentationEntry(slots, 'conversation.composer',
        entry => entry.children?.['conversation.plan-review.actions'] !== undefined && typeof entry.select === 'function', native => {
        const select = native.select as (owner: unknown) => unknown
        const removeQuestion = slots.register({
          name: 'conversation.composer', priority: -100,
          locale: native.locale, store: native.store, inject: native.inject,
          children: { [actionSlot]: { kind: 'list', scope: 'session' } },
          // This selector uses only owner props and the immutable registration scope.
          select: (owner: { sessionId?: string }) => {
            const card = owner.sessionId === sessionId ? select(owner) : null
            return isTranslationQuestionCard(card) ? card : null
          },
        }, props => element(component, {
          matched: props.matched,
          // DSH still owns the component, draft store, injected hooks, and all controls.
          render: (card: TranslationQuestionCard) => element(native.component, {
            ...props, matched: card,
            renderSlot: (name: string, ...args: unknown[]) => props.renderSlot(name === 'conversation.plan-review.actions' ? actionSlot : name, ...args),
          }),
        }))
        try {
          const removeActions = mirrorPresentationSlot(slots, 'conversation.plan-review.actions', actionSlot, element)
          return () => { removeActions(); removeQuestion() }
        } catch (error) { removeQuestion(); throw error }
      })
    },
    todos(render, element) {
      return followPresentationEntry(slots, 'conversation.input.dock', entry => entry.options.id === 'todo', native => {
        return slots.register({ name: 'conversation.input.dock', id: 'todo', priority: -100, order: 0, locale: native.locale },
          (props: { sessionId: string; useProjection(key: string): unknown }) => {
            const value = props.useProjection('todos')
            const todos = Array.isArray(value) ? value.filter(isTranslationTodo) : []
            return render({ sessionId: props.sessionId, todos, original: element(native.component, props) })
          })
      })
    },
    questionHistory(render, element) {
      return followPresentationEntry(slots, 'tool.call.toolview', entry => entry.options.key === 'ask_user_question', native => {
        return slots.register({ name: 'tool.call.toolview', key: 'ask_user_question', priority: -100, locale: native.locale, inject: native.inject },
          props => {
            const settled = props.useProjection('userQuestions', (view: any) => view?.settled?.find((row: any) => row.callId === props.callId)?.answers)
            const history = readQuestionHistory(props.block, settled)
            return render({ sessionId: props.sessionId, fields: history === undefined ? [] : questionHistoryFields(history),
              render: result => {
                if (!result.enabled || history === undefined) return element(native.component, props)
                const display = displayQuestionHistory(props.block, history, result)
                return element(native.component, { ...props, block: display.block,
                  // Reopening uses the original record; display labels never become option values.
                  reviewPanel: (callId: string) => props.reviewPanel(callId, { questions: history.questions, answers: history.answers }),
                  useProjection: (key: string, select: (value: any) => unknown) => props.useProjection(key, (view: any) => select(key !== 'userQuestions' || view == null ? view : {
                    ...view, settled: (view.settled ?? []).map((row: any) => row.callId === props.callId ? { ...row, answers: display.answers } : row),
                  })),
                })
              },
            })
          })
      })
    },
  }
}

export function isTranslationQuestionCard(value: unknown): value is TranslationQuestionCard {
  if (typeof value !== 'object' || value === null) return false
  const card = value as Record<string, any>
  return (card.kind === 'question' || card.kind === 'plan-review') && typeof card.key === 'string'
    && typeof card.sessionId === 'string' && Array.isArray(card.questions)
    && card.questions.every((q: any) => q !== null && typeof q === 'object' && typeof q.id === 'string' && typeof q.question === 'string')
    && ['subscribe', 'snapshot', 'answer', 'dismiss', 'engage', 'takeTime', 'holdFocus', 'releaseFocus'].every(name => typeof card[name] === 'function')
}

function isTranslationTodo(value: unknown): value is TranslationTodo {
  const item = value as Partial<TranslationTodo> | null
  return item !== null && typeof item?.content === 'string' && ['pending', 'in_progress', 'completed'].includes(item.status ?? '')
}
