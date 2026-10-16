import type { IncomingMessage, ServerResponse } from 'node:http'

/** Stable internal boundary; probing must remain safe in the shared client registry. */
export interface QuickAppProxyServer {
  getOrigin(): string
  register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void | Promise<void>
}
function webServer(context: unknown): QuickAppProxyServer | undefined {
  const ctx = context as { get?(name: string): unknown; webServer?: unknown } | undefined
  try { return (ctx?.get ? ctx.get('webServer') : ctx?.webServer) as QuickAppProxyServer | undefined } catch { return undefined }
}
export function supportsQuickAppProxy(context: unknown): boolean {
  const server = webServer(context)
  return typeof server?.register === 'function' && typeof server.getOrigin === 'function'
}
export function createQuickAppProxy(context: unknown): QuickAppProxyServer {
  const server = webServer(context)!
  return { getOrigin: () => server.getOrigin(), register: route => server.register(route) }
}
