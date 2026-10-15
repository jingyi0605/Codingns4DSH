import type { CodingNsRpcClient } from './features/types.js'
import { callCodingNsRpc } from './settings-bridge.js'
import { resolveCodingNsTranslator, type CodingNsLocale } from './locale.js'

const REQUEST = 'codingns.html-files.request.v1'
const RESPONSE = 'codingns.html-files.response.v1'
const OPERATIONS = new Set(['connect', 'list', 'read', 'write', 'delete'])

interface PreviewTarget {
  frame: HTMLIFrameElement
  address: string
  src: string
  sessionId: string
  documentPath: string
}

interface Grant extends PreviewTarget { scopes: string[] }

/** Connect only the live native preview's window, retaining its Host/session identity. */
function previewTarget(source: MessageEventSource | null): PreviewTarget | undefined {
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('[data-document-preview] iframe[data-html-preview]')) {
    if (!frame.isConnected || frame.contentWindow !== source) continue
    const address = frame.closest('[data-document-preview]')?.getAttribute('data-textpreview-url') ?? ''
    const match = /^dsh-resource:\/\/file\/session\/([^/]+)\/(.*)$/u.exec(address)
    if (!match) return undefined
    try {
      const documentPath = decodeURIComponent(match[2] ?? '')
      if (!/\.html?$/iu.test(documentPath)) return undefined
      return { frame, address, src: frame.src, sessionId: decodeURIComponent(match[1] ?? ''), documentPath }
    } catch { return undefined }
  }
  return undefined
}

export function startHtmlWorkspaceFiles(rpc: CodingNsRpcClient, locale?: CodingNsLocale): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined
  const grants = new WeakMap<HTMLIFrameElement, Grant>()
  const connecting = new WeakSet<HTMLIFrameElement>()
  const navigations = new WeakMap<HTMLIFrameElement, number>()
  const controller = new AbortController()
  const t = resolveCodingNsTranslator(locale)
  const scopedRpc: CodingNsRpcClient = {
    call: (channel, endpoint, payload) => rpc.call(channel, endpoint, payload, controller.signal),
  }

  const onMessage = (event: MessageEvent): void => { void handleMessage(event) }
  async function handleMessage(event: MessageEvent): Promise<void> {
    const data = event.data as Record<string, unknown> | null
    if (!data || data.type !== REQUEST || typeof data.id !== 'string' || data.id.length > 100 || typeof data.operation !== 'string') return
    const target = previewTarget(event.source)
    if (!target) return
    if (!navigations.has(target.frame)) {
      navigations.set(target.frame, 0)
      target.frame.addEventListener('load', () => {
        grants.delete(target.frame)
        navigations.set(target.frame, (navigations.get(target.frame) ?? 0) + 1)
      }, { signal: controller.signal })
    }
    const navigation = navigations.get(target.frame)
    const live = (): boolean => {
      const current = previewTarget(event.source)
      return !controller.signal.aborted && navigations.get(target.frame) === navigation
        && current?.frame === target.frame && current.address === target.address && current.src === target.src
    }
    const reply = (result: Record<string, unknown>): void => {
      if (live()) target.frame.contentWindow?.postMessage({ type: RESPONSE, id: data.id, ...result }, '*')
    }
    const call = (operation: string, scopes: string[]) => callCodingNsRpc(scopedRpc, 'fileManagement/html-files', {
      operation, sessionId: target.sessionId, documentPath: target.documentPath, scopes,
      path: data.path, content: data.content, ifMtime: data.ifMtime, createOnly: data.createOnly,
    })
    try {
      if (data.operation === 'probe') { reply({ ok: true, value: { available: true } }); return }
      if (!OPERATIONS.has(data.operation)) throw new Error('Unsupported file operation')
      let grant = grants.get(target.frame)
      if (grant?.address !== target.address || grant.src !== target.src) grant = undefined
      if (data.operation === 'connect') {
        if (connecting.has(target.frame)) throw new Error('A connection request is already pending')
        if (!Array.isArray(data.scopes) || data.scopes.length === 0 || data.scopes.length > 8 || data.scopes.some(value => typeof value !== 'string')) throw new Error('Invalid file scopes')
        const scopes = data.scopes as string[]
        connecting.add(target.frame)
        try {
          const checked = await call('connect', scopes) as { scopes: string[] }
          if (!live()) return
          if (!grant || JSON.stringify(grant.scopes) !== JSON.stringify(scopes)) {
            if (!window.confirm(t('htmlFiles.confirmConnect', { path: target.documentPath, scopes: checked.scopes.join('\n') }))) {
              reply({ ok: false, error: { code: 'HTML_FILES_CANCELLED', message: t('htmlFiles.cancelled') } }); return
            }
          }
          grants.set(target.frame, { ...target, scopes: [...scopes] })
          reply({ ok: true, value: { connected: true } })
        } finally { connecting.delete(target.frame) }
        return
      }
      if (!grant) throw new Error('Connect this HTML page to its workspace before accessing files')
      const value = await call(data.operation, grant.scopes)
      reply({ ok: true, value })
    } catch (error) {
      reply({ ok: false, error: { code: (error as { code?: string })?.code ?? 'HTML_FILES_FAILED', message: error instanceof Error ? error.message : String(error) } })
    }
  }
  window.addEventListener('message', onMessage)
  return () => { controller.abort(); window.removeEventListener('message', onMessage) }
}
