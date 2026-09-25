export interface CodingNsSidebarService {
  register?: (definition: unknown) => (() => void) | void
  registerTab?: (definition: unknown) => (() => void) | void
  open?: (id: string, options?: unknown) => void
}

export function registerSidebarTab(service: CodingNsSidebarService, definition: unknown): () => void {
  const disposer = service.registerTab?.(definition) ?? service.register?.(definition)
  return typeof disposer === 'function' ? disposer : () => undefined
}
