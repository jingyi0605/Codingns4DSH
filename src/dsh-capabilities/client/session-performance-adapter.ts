import type { ComponentType } from 'react'
import { CODEX_PERFORMANCE_PROJECTION } from '../../shared/codex-performance.js'
import { GROK_CONTEXT_PROJECTION, GROK_PERFORMANCE_PROJECTION } from '../../shared/request-performance.js'
import type { MagpieContextSession } from '../../shared/contracts/magpie-management.js'
import { installComposerPresentation, type ComposerPresentationHooks } from './composer-presentation-adapter.js'
import { followPresentationEntry, type PresentationSlots, type RenderElement } from './slot-presentation-mirror.js'

export interface SessionPerformancePresentation {
  install(
    useAdapter: (id: string) => string | undefined,
    element: RenderElement,
    hooks: ComposerPresentationHooks,
    options?: SessionPerformancePresentationOptions,
  ): () => void
}

/** Client-only context UI supplied at the runtime boundary to keep Host bundles React-free. */
export interface SessionPerformancePresentationOptions {
  readonly magpieContext?: {
    readonly component: ComponentType<any>
    readonly rpc: unknown
    readonly locale?: unknown
    /** Hook supplied by Client to read the current Magpie snapshot. */
    readonly useSnapshot?: (rpc: unknown, sessionId: string | undefined) => MagpieContextSession | null
    /** Compatibility fallback for older Client wiring. */
    readonly useReady?: (rpc: unknown, sessionId: string | undefined) => boolean
  }
}

export function supportsSessionPerformancePresentation(context: unknown): boolean {
  const slots = (context as { slots?: Partial<PresentationSlots> })?.slots
  return slots !== undefined && ['inject', 'register', 'entries', 'subscribe'].every(key => typeof slots[key as keyof PresentationSlots] === 'function')
}

/** Reuse the native activity pill, dialog, localization, settings, and session binding. */
export function createSessionPerformancePresentation(context: unknown): SessionPerformancePresentation {
  const slots = (context as { slots: PresentationSlots }).slots
  return {
    install(useAdapter, element, hooks, options) {
      const wrappers = new Set<unknown>()
      const removeActivity = followPresentationEntry(slots, 'conversation.composer.dock',
        entry => entry.options.id === 'activity' && !wrappers.has(entry.component),
        native => {
          const Activity = native.component as ComponentType<any>
          function ActivityWithSourceTiming(props: any) {
            const adapter = useAdapter(props.sessionId)
            return element(Activity, {
              ...props,
              useProjection: (key: string, ...args: unknown[]) => {
                const original = props.useProjection(key, ...args)
                if (key !== 'sessionStats') return original
                // Read both sources on every render, including adapter changes and cold loading.
                const value = props.useProjection(adapter === 'grok' ? GROK_PERFORMANCE_PROJECTION : CODEX_PERFORMANCE_PROJECTION, ...args)
                if (adapter !== 'codex' && adapter !== 'grok') return original
                // Old histories have no recoverable source timing. Keep counts but omit a fabricated speed.
                return value ?? { turns: 0, steps: 0, toolMs: 0, ...original, llmMs: 0, decodeTokens: 0, decodeMs: 0, ttftMs: 0, ttftSteps: 0 }
              },
            })
          }
          wrappers.add(ActivityWithSourceTiming)
          const remove = slots.register({
            name: 'conversation.composer.dock', ...native.options,
            priority: (native.options.priority ?? 0) - 1,
            ...(native.inject === undefined ? {} : { inject: native.inject }),
            ...(native.locale === undefined ? {} : { locale: native.locale }),
          }, ActivityWithSourceTiming)
          return () => { remove(); wrappers.delete(ActivityWithSourceTiming) }
        })
      try {
        const removeContext = installGrokContextPresentation(context as object, slots, useAdapter, element, hooks, options)
        return () => { removeContext(); removeActivity() }
      } catch (error) { removeActivity(); throw error }
    },
  }
}

/** ContextMeter lives inside the native composer bar, rather than in its own slot. */
function installGrokContextPresentation(
  owner: object,
  slots: PresentationSlots,
  useAdapter: (id: string) => string | undefined,
  element: RenderElement,
  hooks: ComposerPresentationHooks,
  options?: SessionPerformancePresentationOptions,
): () => void {
  const magpieContext = options?.magpieContext
  const removeMagpieMeter = magpieContext === undefined ? () => undefined : installMagpieContextDock(slots, magpieContext, element)
  try {
    const removeComposer = installComposerPresentation(owner, slots, Native => function ComposerWithGrokContext(props) {
    const adapter = useAdapter(props.sessionId ?? '')
    const magpieSnapshot = magpieContext?.useSnapshot?.(magpieContext.rpc, props.sessionId) ?? null
    const legacyMagpieReady = magpieContext?.useReady?.(magpieContext.rpc, props.sessionId) === true
    const magpieReady = magpieSnapshot !== null || legacyMagpieReady
    return element(Native, {
      ...props,
      useProjection: (key: string, ...args: unknown[]) => {
        const original = props.useProjection(key, ...args)
        if (key === 'contextBreakdown' && (adapter === 'grok' || magpieReady)) return undefined
        if (key !== 'contextPressure') return original
        // Projection readers are hooks; loading Magpie must not skip this read.
        const value = props.useProjection(GROK_CONTEXT_PROJECTION)
        if (magpieSnapshot !== null) {
          const pressure = { pressureTokens: magpieSnapshot.usedTokens, contextWindow: magpieSnapshot.contextWindow }
          return typeof args[0] === 'function' ? args[0](pressure) : pressure
        }
        if (magpieReady) return undefined
        if (adapter !== 'grok') return original
        const pressure = value ?? {}
        return typeof args[0] === 'function' ? args[0](pressure) : pressure
      },
    })
    }, element, hooks)
    return () => { removeComposer(); removeMagpieMeter() }
  } catch (error) {
    removeMagpieMeter()
    throw error
  }
}

/** Mount a zero-layout Client enhancer beside the native ContextMeter. */
function installMagpieContextDock(
  slots: PresentationSlots,
  magpieContext: NonNullable<SessionPerformancePresentationOptions['magpieContext']>,
  element: RenderElement,
): () => void {
  return slots.inject('conversation.composer.dock', () => slots.register({
    name: 'conversation.composer.dock',
    id: 'codingns-magpie-context',
    order: -10,
    inject: (sessionId: string) => ({
      rpc: magpieContext.rpc,
      sessionId,
      ...(magpieContext.locale === undefined ? {} : { locale: magpieContext.locale }),
    }),
  }, props => element(magpieContext.component, props)))
}
