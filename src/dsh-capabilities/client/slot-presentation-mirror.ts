import type { ComponentType, ReactElement } from 'react'

export type RenderElement = (component: ComponentType<any>, props: any) => ReactElement

interface PresentationEntry {
  readonly component: ComponentType<any>
  readonly options: { id?: string; key?: string; order?: number; priority?: number; label?: unknown }
  readonly locale?: string
  readonly inject?: unknown
  readonly store?: unknown
  readonly select?: unknown
  readonly children?: Readonly<Record<string, { kind: string; scope: string }>>
}

export interface PresentationSlots {
  inject(name: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: ComponentType<any>): () => void
  entries(name: string): readonly PresentationEntry[]
  subscribe(name: string, listener: () => void): () => void
}

/** Render existing actions in an owned slot without redeclaring or mutating native slots. */
export function mirrorPresentationSlot(slots: PresentationSlots, source: string, target: string, element: RenderElement): () => void {
  return slots.inject(source, () => {
    const mounted = new Map<PresentationEntry, () => void>()
    const clear = (): void => { for (const dispose of mounted.values()) dispose(); mounted.clear() }
    const reconcile = (): void => {
      const entries = slots.entries(source)
      for (const [entry, dispose] of mounted) {
        if (!entries.includes(entry)) { dispose(); mounted.delete(entry) }
      }
      for (const entry of entries) {
        if (mounted.has(entry)) continue
        const names = Object.fromEntries(Object.keys(entry.children ?? {}).map(key => [key, `${target}.${encodeURIComponent(key)}`]))
        const children = entry.children === undefined ? undefined
          : Object.fromEntries(Object.entries(entry.children).map(([key, spec]) => [names[key], spec]))
        const removeEntry = slots.register({
          name: target, ...entry.options,
          ...(entry.locale === undefined ? {} : { locale: entry.locale }),
          ...(entry.inject === undefined ? {} : { inject: entry.inject }),
          ...(entry.store === undefined ? {} : { store: entry.store }),
          ...(entry.select === undefined ? {} : { select: entry.select }),
          ...(children === undefined ? {} : { children }),
        }, children === undefined ? entry.component : props => element(entry.component, {
          ...props,
          renderSlot: (key: string, ...args: unknown[]) => props.renderSlot(names[key] ?? key, ...args),
          ...(props.renderSlotChain === undefined ? {} : {
            renderSlotChain: (key: string, ...args: unknown[]) => props.renderSlotChain(names[key] ?? key, ...args),
          }),
        }))
        const descendants: (() => void)[] = []
        try {
          for (const [key, name] of Object.entries(names)) descendants.push(mirrorPresentationSlot(slots, key, name, element))
        } catch (error) {
          for (const dispose of descendants.reverse()) dispose()
          removeEntry()
          throw error
        }
        mounted.set(entry, () => { for (const dispose of descendants.reverse()) dispose(); removeEntry() })
      }
    }
    const unsubscribe = slots.subscribe(source, reconcile)
    try { reconcile() } catch (error) { unsubscribe(); clear(); throw error }
    return () => { unsubscribe(); clear() }
  })
}
