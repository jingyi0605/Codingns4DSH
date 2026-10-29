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
// The native `current` reader survives our in-place getter override, so the
// native-route probe can bypass the external overlay without recursing.
const NATIVE_CURRENT = Symbol.for('codingns4dsh.native-model-current')
type NativeSelectionRef = SelectionRef & {
  readonly [NATIVE_CURRENT]?: () => SessionModelSelection
}
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
  const selection = accessor.call(owner, agent) as NativeSelectionRef
  const native = selection[NATIVE_CURRENT]
  return native !== undefined ? native() : selection.current
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
      const selectionFor: SelectionOwner['selectionFor'] = function (this: SelectionOwner, agent) {
        const selection = original.call(this, agent) as NativeSelectionRef
        if (restores.has(selection)) return selection
        const sessionId = agent.id
        const descriptor = Object.getOwnPropertyDescriptor(selection, 'current')!
        let nativeValue = descriptor.value as SessionModelSelection
        const readNative = descriptor.get
          ? () => descriptor.get!.call(selection) as SessionModelSelection
          : () => nativeValue
        // DSH listeners retain this object. A Proxy return value cannot change
        // their reads; wrap the native getter without overwriting its choices.
        const get = () => resolve(sessionId) ?? readNative()
        Object.defineProperty(selection, 'current', {
          configurable: descriptor.configurable === true,
          enumerable: descriptor.enumerable === true,
          get,
          set(next: SessionModelSelection) {
            if (descriptor.set) descriptor.set.call(selection, next)
            else nativeValue = next
          },
        })
        Object.defineProperty(selection, NATIVE_CURRENT, { configurable: true, value: readNative })
        restores.set(selection, () => {
          if (Object.getOwnPropertyDescriptor(selection, 'current')?.get !== get) return
          Reflect.deleteProperty(selection, NATIVE_CURRENT)
          Object.defineProperty(selection, 'current', 'value' in descriptor ? { ...descriptor, value: nativeValue } : descriptor)
        })
        references.add(new WeakRef(selection))
        return selection
      }
      Object.defineProperty(selectionFor, NATIVE_ACCESSOR, {
        value: { native: (original as SelectionAccessor)[NATIVE_ACCESSOR]?.native ?? original, installed: selectionFor },
      })
      owner.selectionFor = selectionFor
      return () => {
        for (const reference of references) {
          const selection = reference.deref()
          if (selection !== undefined) restores.get(selection)?.()
        }
        references.clear()
        if ((owner.selectionFor as SelectionAccessor)[NATIVE_ACCESSOR]?.installed !== selectionFor) return
        if (ownDescriptor !== undefined) Object.defineProperty(owner, 'selectionFor', ownDescriptor)
        else Reflect.deleteProperty(owner, 'selectionFor')
      }
    },
  }
}
