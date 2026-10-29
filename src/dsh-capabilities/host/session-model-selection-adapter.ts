export interface SessionModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

interface SelectionRef {
  current: SessionModelSelection
}

interface SelectionOwner {
  selectionFor(agent: { readonly id: string }): SelectionRef
}

export interface SessionModelSelectionAdapter {
  install(resolve: (sessionId: string) => SessionModelSelection | undefined): () => void
}

function selectionOwner(controller: unknown): SelectionOwner | undefined {
  const owner = (controller as { agents?: Partial<SelectionOwner> } | undefined)?.agents
  return typeof owner?.selectionFor === 'function' ? owner as SelectionOwner : undefined
}

export function supportsSessionModelSelection(controller: unknown): boolean {
  return selectionOwner(controller) !== undefined
}

/**
 * DSH's prompt admission reads selectionFor().current before agent/request.
 * Its public selectModel() also persists the global default and requires a
 * catalog entry, so external routes must not use it for this session-local view.
 * Keep this internal accessor behind the bounded, structurally probed route.
 */
export function createSessionModelSelectionAdapter(controller: unknown): SessionModelSelectionAdapter {
  const owner = selectionOwner(controller)!
  return {
    install(resolve) {
      const original = owner.selectionFor
      const ownDescriptor = Object.getOwnPropertyDescriptor(owner, 'selectionFor')
      const restores = new WeakMap<SelectionRef, () => void>()
      const references = new Set<WeakRef<SelectionRef>>()
      const installed = Symbol('CodingNS model selection accessor')
      const selectionFor: SelectionOwner['selectionFor'] = function (this: SelectionOwner, agent) {
        const selection = original.call(this, agent)
        if (restores.has(selection)) return selection
        const sessionId = agent.id
        const descriptor = Object.getOwnPropertyDescriptor(selection, 'current')!
        let nativeValue = descriptor.value as SessionModelSelection
        // DSH listeners retain this object. A Proxy return value cannot change
        // their reads; wrap the native getter without overwriting its choices.
        const get = () => resolve(sessionId)
          ?? (descriptor.get ? descriptor.get.call(selection) as SessionModelSelection : nativeValue)
        Object.defineProperty(selection, 'current', {
          configurable: descriptor.configurable === true,
          enumerable: descriptor.enumerable === true,
          get,
          set(next: SessionModelSelection) {
            if (descriptor.set) descriptor.set.call(selection, next)
            else nativeValue = next
          },
        })
        restores.set(selection, () => {
          if (Object.getOwnPropertyDescriptor(selection, 'current')?.get !== get) return
          Object.defineProperty(selection, 'current', 'value' in descriptor ? { ...descriptor, value: nativeValue } : descriptor)
        })
        references.add(new WeakRef(selection))
        return selection
      }
      // Cordis returns fresh method proxies, but preserves function properties.
      Object.defineProperty(selectionFor, installed, { value: true })
      owner.selectionFor = selectionFor
      return () => {
        for (const reference of references) {
          const selection = reference.deref()
          if (selection !== undefined) restores.get(selection)?.()
        }
        references.clear()
        if (Reflect.get(owner.selectionFor, installed) !== true) return
        if (ownDescriptor !== undefined) Object.defineProperty(owner, 'selectionFor', ownDescriptor)
        else Reflect.deleteProperty(owner, 'selectionFor')
      }
    },
  }
}
