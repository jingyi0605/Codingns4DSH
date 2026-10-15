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
      const selectionFor: SelectionOwner['selectionFor'] = function (this: SelectionOwner, agent) {
        const selection = original.call(this, agent)
        const external = resolve(agent.id)
        if (external === undefined) return selection
        // The native reference and its setters remain owned by DSH. Returning a
        // view avoids overwriting pending native choices or the global default.
        return new Proxy(selection, {
          get(target, key, receiver) {
            return key === 'current' ? external : Reflect.get(target, key, receiver)
          },
        })
      }
      owner.selectionFor = selectionFor
      return () => {
        if (owner.selectionFor !== selectionFor) return
        if (ownDescriptor !== undefined) Object.defineProperty(owner, 'selectionFor', ownDescriptor)
        else Reflect.deleteProperty(owner, 'selectionFor')
      }
    },
  }
}
