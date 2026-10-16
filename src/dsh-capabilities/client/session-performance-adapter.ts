import type { ComponentType } from 'react'
import { CODEX_PERFORMANCE_PROJECTION } from '../../shared/codex-performance.js'
import { GROK_CONTEXT_PROJECTION, GROK_PERFORMANCE_PROJECTION } from '../../shared/request-performance.js'
import { contextComposerSlotName } from './composer-slot-selectors.js'
import { followPresentationEntry, mirrorPresentationSlot, type PresentationSlots, type RenderElement } from './slot-presentation-mirror.js'

export interface SessionPerformancePresentation {
  install(useAdapter: (id: string) => string | undefined, element: RenderElement): () => void
}

export function supportsSessionPerformancePresentation(context: unknown): boolean {
  const slots = (context as { slots?: Partial<PresentationSlots> })?.slots
  return slots !== undefined && ['inject', 'register', 'entries', 'subscribe'].every(key => typeof slots[key as keyof PresentationSlots] === 'function')
}

/** Reuse the native activity pill, dialog, localization, settings, and session binding. */
export function createSessionPerformancePresentation(context: unknown): SessionPerformancePresentation {
  const slots = (context as { slots: PresentationSlots }).slots
  return {
    install(useAdapter, element) {
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
        const removeContext = installGrokContextPresentation(slots, useAdapter, element)
        return () => { removeContext(); removeActivity() }
      } catch (error) { removeActivity(); throw error }
    },
  }
}

/** ContextMeter lives inside the native composer bar, rather than in its own slot. */
function installGrokContextPresentation(slots: PresentationSlots, useAdapter: (id: string) => string | undefined, element: RenderElement): () => void {
  return followPresentationEntry(slots, 'conversation.composer.bar',
    entry => entry.children?.['conversation.composer.dock'] !== undefined,
    native => {
      const names = Object.fromEntries(Object.keys(native.children ?? {}).map(name => [name, contextComposerSlotName(name)]))
      const removers: (() => void)[] = []
      const remove = slots.register({
        name: 'conversation.composer.bar', ...native.options,
        priority: (native.options.priority ?? 0) - 1,
        locale: native.locale, inject: native.inject, store: native.store, select: native.select,
        children: Object.fromEntries(Object.entries(native.children ?? {}).map(([name, spec]) => [names[name], spec])),
      }, props => {
        const adapter = useAdapter(props.sessionId ?? '')
        return element(native.component, {
          ...props,
          renderSlot: (name: string, ...args: unknown[]) => props.renderSlot(names[name] ?? name, ...args),
          ...(props.renderSlotChain === undefined ? {} : {
            renderSlotChain: (name: string, ...args: unknown[]) => props.renderSlotChain(names[name] ?? name, ...args),
          }),
          useProjection: (key: string, ...args: unknown[]) => {
            const original = props.useProjection(key, ...args)
            if (key === 'contextBreakdown' && adapter === 'grok') return undefined
            if (key !== 'contextPressure') return original
            const value = props.useProjection(GROK_CONTEXT_PROJECTION)
            if (adapter !== 'grok') return original
            const pressure = value ?? {}
            return typeof args[0] === 'function' ? args[0](pressure) : pressure
          },
        })
      })
      try {
        for (const [source, target] of Object.entries(names)) removers.push(mirrorPresentationSlot(slots, source, target, element))
      } catch (error) {
        for (const dispose of removers.reverse()) dispose()
        remove()
        throw error
      }
      return () => { for (const dispose of removers.reverse()) dispose(); remove() }
    })
}
