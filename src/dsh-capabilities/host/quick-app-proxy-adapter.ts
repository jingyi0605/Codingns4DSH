import type { IncomingMessage, ServerResponse } from 'node:http'

/** Stable internal boundary; probing must remain safe in the shared client registry. */
export interface QuickAppProxyServer {
  getOrigin(): string
  register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void | Promise<void>
}
interface NativeQuickAppProxyServer {
  register: QuickAppProxyServer['register']
  getOrigin?(): string
  readonly host?: string
  readonly port?: number
}
function webServer(context: unknown): NativeQuickAppProxyServer | undefined {
  const ctx = context as { get?(name: string): unknown; webServer?: unknown } | undefined
  try { return (ctx?.get ? ctx.get('webServer') : ctx?.webServer) as NativeQuickAppProxyServer | undefined } catch { return undefined }
}
function hasLocalListener(server: NativeQuickAppProxyServer): boolean {
  const { host, port } = server
  return (host === '127.0.0.1' || host === '0.0.0.0')
    && typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
}
export function supportsQuickAppProxy(context: unknown): boolean {
  const server = webServer(context)
  return typeof server?.register === 'function' && (typeof server.getOrigin === 'function' || hasLocalListener(server))
}
export function createQuickAppProxy(context: unknown): QuickAppProxyServer {
  const server = webServer(context)!
  return { getOrigin: () => {
    if (typeof server.getOrigin === 'function') return server.getOrigin()
    // rc.2 exposes the listening address directly; wildcard binds are reached over loopback.
    if (!hasLocalListener(server)) throw new Error('The Host HTTP listener is unavailable.')
    return new URL(`http://127.0.0.1:${server.port}`).origin
  }, register: route => server.register(route) }
}
