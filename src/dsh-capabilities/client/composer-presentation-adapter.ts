import type { ComponentType } from 'react'
import { contextComposerSlotName } from './composer-slot-selectors.js'
import { followPresentationEntry, mirrorPresentationSlot, type PresentationSlots, type RenderElement } from './slot-presentation-mirror.js'

type ComposerDecorator = (component: ComponentType<any>) => ComponentType<any>
export type ComposerPresentationHooks = Pick<typeof import('react'), 'useMemo' | 'useSyncExternalStore'>
interface ComposerPresentation {
  decorators: readonly ComposerDecorator[]
  readonly listeners: Set<() => void>
  dispose(): void
}
const presentations = new WeakMap<object, ComposerPresentation>()

/** Compose customizations over one native composer, sharing its child-slot mirror. */
export function installComposerPresentation(owner: object, slots: PresentationSlots, decorate: ComposerDecorator, element: RenderElement, hooks: ComposerPresentationHooks): () => void {
  // Shared capability routes also load on the Host; the client supplies its React hooks.
  const { useMemo, useSyncExternalStore } = hooks
  // Cordis can return a fresh service proxy on every access. The owning context is stable.
  let presentation = presentations.get(owner)
  if (presentation === undefined) {
    const state: ComposerPresentation = { decorators: [decorate], listeners: new Set(), dispose: () => undefined }
    const subscribe = (listener: () => void): (() => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener) } }
    const snapshot = (): readonly ComposerDecorator[] => state.decorators
    state.dispose = followPresentationEntry(slots, 'conversation.composer.bar',
      entry => entry.children?.['conversation.composer.dock'] !== undefined,
      native => {
        // Retain the existing mirror names so DOM consumers keep finding the composer.
        const names = Object.fromEntries(Object.keys(native.children ?? {}).map(name => [name, contextComposerSlotName(name)]))
        const removers: (() => void)[] = []
        const remove = slots.register({
          name: 'conversation.composer.bar', ...native.options,
          priority: (native.options.priority ?? 0) - 1,
          locale: native.locale, inject: native.inject, store: native.store, select: native.select,
          children: Object.fromEntries(Object.entries(native.children ?? {}).map(([name, spec]) => [names[name], spec])),
        }, props => {
          const decorators = useSyncExternalStore(subscribe, snapshot, snapshot)
          const Composer = useMemo(() => decorators.reduceRight((component, wrapper) => wrapper(component), native.component), [decorators])
          return element(Composer, {
            ...props,
            renderSlot: (name: string, ...args: unknown[]) => props.renderSlot(names[name] ?? name, ...args),
            ...(props.renderSlotChain === undefined ? {} : {
              renderSlotChain: (name: string, ...args: unknown[]) => props.renderSlotChain(names[name] ?? name, ...args),
            }),
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
    presentation = state
    presentations.set(owner, state)
  } else {
    presentation.decorators = [...presentation.decorators, decorate]
    for (const listener of presentation.listeners) listener()
  }
  const state = presentation
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    state.decorators = state.decorators.filter(wrapper => wrapper !== decorate)
    if (state.decorators.length === 0) { state.dispose(); presentations.delete(owner) }
    else for (const listener of state.listeners) listener()
  }
}
