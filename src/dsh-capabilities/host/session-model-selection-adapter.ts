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

// Cordis creates fresh method proxies. Symbol properties survive those proxies
// and retain the native accessor across plugin reloads.
const NATIVE_ACCESSOR = Symbol.for('codingns4dsh.native-model-selection')
type SelectionAccessor = SelectionOwner['selectionFor'] & {
  readonly [NATIVE_ACCESSOR]?: {
    readonly native: SelectionOwner['selectionFor']
    readonly installed: SelectionOwner['selectionFor']
  }
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

/** Read DSH's own route without re-entering our external session resolver. */
export function readNativeSessionModelSelection(controller: unknown, agent: { readonly id: string }): SessionModelSelection | undefined {
  const owner = selectionOwner(controller)
  if (owner === undefined) return undefined
  const current = owner.selectionFor as SelectionAccessor
  const accessor = current[NATIVE_ACCESSOR]?.native ?? current
  return accessor.call(owner, agent).current
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
      Object.defineProperty(selectionFor, NATIVE_ACCESSOR, {
        value: { native: (original as SelectionAccessor)[NATIVE_ACCESSOR]?.native ?? original, installed: selectionFor },
      })
      owner.selectionFor = selectionFor
      return () => {
        if ((owner.selectionFor as SelectionAccessor)[NATIVE_ACCESSOR]?.installed !== selectionFor) return
        if (ownDescriptor !== undefined) Object.defineProperty(owner, 'selectionFor', ownDescriptor)
        else Reflect.deleteProperty(owner, 'selectionFor')
      }
    },
  }
}
