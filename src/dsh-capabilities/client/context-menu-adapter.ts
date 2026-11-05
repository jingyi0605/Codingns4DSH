/** CodingNS's stable view of DSH alpha.3's shared context-menu service. */
export interface DshContextMenuAdapter {
  register(input: DshContextMenuContribution): () => void
  notify(text: string, success?: boolean): void
}

export interface DshContextMenuContribution {
  readonly id: string
  readonly target: string
  readonly order: number
  readonly resolve: (target: unknown, signal: AbortSignal) => readonly DshContextMenuAction[] | Promise<readonly DshContextMenuAction[]>
}

export interface DshContextMenuAction {
  readonly id: string
  readonly label: string
  readonly disabled?: boolean
  readonly danger?: boolean
  readonly separatorBefore?: boolean
  readonly run?: () => void | Promise<void>
}

interface NativeContextMenus {
  register(input: unknown): () => void
  notify(text: string, success?: boolean): void
}

export function readContextMenus(context: unknown): DshContextMenuAdapter | undefined {
  const native = readService(context, 'contextMenus') as NativeContextMenus | undefined
  if (!isNativeContextMenus(native)) return undefined
  return {
    register(input) {
      return native.register(input)
    },
    notify(text, success = false) {
      native.notify(text, success)
    },
  }
}

export function supportsContextMenus(context: unknown): boolean {
  return isNativeContextMenus(readService(context, 'contextMenus') as NativeContextMenus | undefined)
}

function isNativeContextMenus(value: NativeContextMenus | undefined): value is NativeContextMenus {
  return typeof value?.register === 'function' && typeof value.notify === 'function'
}

function readService(context: unknown, name: string): unknown {
  if (typeof context !== 'object' || context === null) return undefined
  try {
    const getter = Reflect.get(context, 'get')
    if (typeof getter === 'function') return getter.call(context, name)
    return Reflect.get(context, name)
  } catch {
    return undefined
  }
}
