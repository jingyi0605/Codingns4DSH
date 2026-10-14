import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react'
import { createDshCapabilityRegistry } from '../dsh-capabilities/routes.js'
import type { InteractionPresentationBridge, QuestionHistoryPresentation, QuestionPresentation } from '../dsh-capabilities/client/interaction-presentation-adapter.js'
import { watchNativeInteractionText, type NativeInteractionTextKind } from '../dsh-capabilities/client/interaction-text-dom.js'
import type { TranslationQuestionCard, TranslationTodo } from '../shared/contracts/interaction-presentation.js'
import {
  answerTranslationFields, translatedAnswer,
  type InteractionAnswer, type InteractionTranslationField, type InteractionTranslationResult,
} from '../shared/contracts/interaction-translation.js'
import type { CodingNsClientServices } from './features/types.js'
import { callCliRpc } from './cli-catalog.js'
import { useCliSessionTranslationEnabled } from './cli-slots.js'

const EMPTY_RESULT: InteractionTranslationResult = { enabled: false, records: {} }

export async function translateInteractionFields(
  services: Pick<CodingNsClientServices, 'rpc'>, sessionId: string, direction: 'input' | 'output',
  fields: readonly InteractionTranslationField[], signal?: AbortSignal,
): Promise<InteractionTranslationResult> {
  if (fields.length === 0) return EMPTY_RESULT
  return callCliRpc(services.rpc, 'translation/fields', { sessionId, direction, fields }, signal)
}

/** Undefined means pending; a disabled response must not be confused with an unfinished request. */
function useFieldTranslations(services: CodingNsClientServices, sessionId: string, fields: readonly InteractionTranslationField[], enabled = true): InteractionTranslationResult | undefined {
  const store = useMemo(() => ({
    subscribe: (listener: () => void) => services.settings.subscribe(listener),
    getSnapshot: () => services.settings.getSnapshot(),
  }), [services.settings])
  const settings = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const key = JSON.stringify([sessionId, settings.value?.sessionTranslation, fields])
  const [state, setState] = useState<{ key: string; result: InteractionTranslationResult }>()
  useEffect(() => {
    if (!enabled || fields.length === 0) return
    const controller = new AbortController()
    setState(undefined)
    void translateInteractionFields(services, sessionId, 'output', fields, controller.signal).then(result => {
      if (!controller.signal.aborted) setState({ key, result })
    }).catch(() => {
      // An empty, enabled result marks every requested field as failed, ending its spinner.
      if (!controller.signal.aborted) setState({ key, result: { enabled: true, records: {} } })
    })
    return () => controller.abort()
  }, [services.rpc, key, enabled])
  return !enabled ? EMPTY_RESULT : state?.key === key ? state.result : undefined
}

/** Intercept only free-text submission; all native values, methods, and draft ownership survive. */
export function createQuestionAnswerTranslation(
  card: TranslationQuestionCard,
  translate: (fields: readonly InteractionTranslationField[], signal: AbortSignal) => Promise<InteractionTranslationResult>,
) {
  let active: { controller: AbortController; promise: Promise<void> } | undefined
  const answer = (value: InteractionAnswer): Promise<void> => {
    if (active !== undefined) return active.promise
    const fields = answerTranslationFields(value)
    if (fields.length === 0) return card.answer(value)
    const controller = new AbortController()
    const unsubscribe = card.subscribe(() => { if (card.snapshot().closed) controller.abort() })
    const promise = (async () => {
      if (card.snapshot().closed) controller.abort()
      controller.signal.throwIfAborted()
      let result = EMPTY_RESULT
      try { result = await translate(fields, controller.signal) } catch { controller.signal.throwIfAborted() }
      controller.signal.throwIfAborted()
      if (card.snapshot().closed || card.snapshot().channel === 'none') throw new Error('Question is no longer available')
      await card.answer(translatedAnswer(value, result))
    })().finally(() => {
      unsubscribe()
      if (active?.controller === controller) active = undefined
    })
    active = { controller, promise }
    return promise
  }
  const methods = new Map<PropertyKey, unknown>()
  const presentation = new Proxy(card, {
    get(target, key) {
      if (key === 'answer') return answer
      const value: unknown = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (!methods.has(key)) methods.set(key, value.bind(target))
      return methods.get(key)
    },
  })
  return { card: presentation, dispose: () => active?.controller.abort() }
}

export function registerSessionTranslationInteractions(services: CodingNsClientServices): () => void {
  const resolution = createDshCapabilityRegistry(services.dshVersion, 'client', services).getProfile(services).capabilities.get('conversation.interaction-translation')
  if (resolution?.status !== 'ready') return () => undefined
  const bridge = resolution.value as InteractionPresentationBridge
  const active = new Map<string, { refs: number; dispose(): void }>()
  const Question = (props: QuestionPresentation) => createElement(NativeQuestionTranslation, { key: props.matched.key, ...props, services })
  const Coordinator = ({ sessionId }: { sessionId: string }): null => {
    const enabled = useCliSessionTranslationEnabled(sessionId, services.rpc)
    useEffect(() => {
      if (!enabled) return
      let entry = active.get(sessionId)
      if (entry === undefined) { entry = { refs: 0, dispose: bridge.questions(sessionId, Question, createElement) }; active.set(sessionId, entry) }
      entry.refs++
      return () => {
        if (--entry.refs === 0) { entry.dispose(); active.delete(sessionId) }
      }
    }, [sessionId, enabled])
    return null
  }
  const removeCoordinator = bridge.coordinator(Coordinator)
  const removeTodos = bridge.todos(props => createElement(NativeTodoTranslation, { ...props, services }), createElement)
  const removeHistory = bridge.questionHistory(props => createElement(TranslatedQuestionHistory, { ...props, services }), createElement)
  return () => {
    removeCoordinator()
    removeTodos()
    removeHistory()
    for (const entry of active.values()) entry.dispose()
    active.clear()
  }
}

export function NativeQuestionTranslation({ matched, render, services }: QuestionPresentation & { readonly services: CodingNsClientServices }): ReactElement {
  const submission = useMemo(() => createQuestionAnswerTranslation(matched,
    (fields, signal) => translateInteractionFields(services, matched.sessionId, 'input', fields, signal),
  ), [matched, services.rpc])
  useEffect(() => () => submission.dispose(), [submission])
  return createElement(NativeTranslatedContent, { sessionId: matched.sessionId, services, kind: 'question', enabled: true, children: render(submission.card) })
}

/** A layout-transparent boundary around DSH's own component, with no replacement controls. */
export function NativeTranslatedContent({ sessionId, services, kind, enabled, children }: {
  readonly sessionId: string; readonly services: CodingNsClientServices; readonly kind: NativeInteractionTextKind
  readonly enabled: boolean; readonly children: ReactElement
}): ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const controller = useRef<ReturnType<typeof watchNativeInteractionText>>()
  const [fields, setFields] = useState<readonly InteractionTranslationField[]>([])
  const result = useFieldTranslations(services, sessionId, fields, enabled)
  useLayoutEffect(() => {
    if (!enabled || root.current === null) return
    const current = watchNativeInteractionText(root.current, kind, setFields)
    controller.current = current
    return () => { current.dispose(); controller.current = undefined }
  }, [sessionId, kind, enabled])
  useLayoutEffect(() => { controller.current?.update(result) }, [result])
  return createElement('div', { ref: root, style: { display: 'contents' }, 'data-codingns-native-translation': kind }, children)
}

export function NativeTodoTranslation({ sessionId, original, services }: {
  readonly sessionId: string; readonly todos: readonly TranslationTodo[]; readonly original: ReactElement; readonly services: CodingNsClientServices
}): ReactElement {
  const enabled = useCliSessionTranslationEnabled(sessionId, services.rpc)
  return createElement(NativeTranslatedContent, { sessionId, services, kind: 'todo', enabled, children: original })
}

function TranslatedQuestionHistory({ sessionId, fields, render, services }: QuestionHistoryPresentation & { readonly services: CodingNsClientServices }): ReactElement {
  const enabled = useCliSessionTranslationEnabled(sessionId, services.rpc)
  const result = useFieldTranslations(services, sessionId, fields, enabled)
  return render(result ?? EMPTY_RESULT)
}
