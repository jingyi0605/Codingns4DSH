import { createElement as h, useEffect, useRef, useState, type ReactElement } from 'react'
import type { QuickApp, QuickAppDocument } from '../../shared/contracts/quick-apps.js'
import type { CodingNsTranslator } from '../locale.js'
import { DshFileTypeIcon, DshPathLabel, DshTooltip, DshModal, DshMenu, classifyDshFileType, resolveAssistantControlIcon, resolveRefreshIcon, resolveTextWrapIcon, resolveViewerIcon, hasNativeMarkdown } from '../../dsh-capabilities/client/primitives-adapter.js'
import type { QuickAppsClient, QuickAppView } from './client.js'
import { QuickAppActions, QuickAppButton } from './ui.js'
import { documentPath, QuickAppEditor, QuickAppMarkdown } from './document.js'
import { attachQuickAppStorageBroker } from './browser-storage.js'

type DocumentMode = 'markdown' | 'source' | 'edit'
const defaultMode = (path: string): DocumentMode => /\.(?:md|markdown)$/iu.test(path) && hasNativeMarkdown() ? 'markdown' : 'source'

/** Native renderers and editor with Quick Apps ownership, save preconditions and lifetime. */
export function QuickAppViewer({ app, view, client, busy, error, t, onClose, onReload }: {
  app: QuickApp; view: QuickAppView; client?: QuickAppsClient; busy: boolean; error?: string | undefined; t: CodingNsTranslator
  onClose(): void; onReload(): void
}): ReactElement {
  const snapshot = () => view.kind === 'text' ? { path: view.path ?? app.entryPath, content: view.content, version: view.version ?? '', canWrite: view.canWrite ?? false } : undefined
  const [doc, setDoc] = useState(snapshot)
  const [draft, setDraft] = useState(view.kind === 'text' ? view.content : '')
  const [mode, setMode] = useState<DocumentMode>(() => defaultMode(app.entryPath))
  const [wrap, setWrap] = useState(true)
  const [maximized, setMaximized] = useState(false)
  const [menu, setMenu] = useState(false)
  const [loading, setLoading] = useState(false)
  const [frameLoading, setFrameLoading] = useState(view.kind === 'html')
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const [confirmation, setConfirmation] = useState<{ kind: 'edit' } | { kind: 'discard'; action(): void } | null>(null)
  const generation = useRef(0)
  const pending = useRef(false)
  const frame = useRef<HTMLIFrameElement | null>(null)
  const storageTranslator = useRef(t)
  storageTranslator.current = t
  const dirty = doc !== undefined && draft !== doc.content
  const path = doc?.path ?? app.entryPath
  const accept = (next: QuickAppDocument) => { setDoc(next); setDraft(next.content) }
  useEffect(() => {
    generation.current++; pending.current = false; setLoading(false); setMessage(null)
    setDoc(snapshot()); setDraft(view.kind === 'text' ? view.content : ''); setMode(defaultMode(app.entryPath)); setFrameLoading(view.kind === 'html')
    return () => { generation.current++ }
  }, [view])
  useEffect(() => { if (error) setFrameLoading(false) }, [error])
  useEffect(() => {
    if (view.kind !== 'html' || view.isolation !== 'sandbox-proxy' || !view.storageToken || !view.storageScope || typeof window === 'undefined') return
    return attachQuickAppStorageBroker({ owner: window, frame: () => frame.current, token: view.storageToken, scope: view.storageScope, expiresAt: view.expiresAt,
      onError: cause => setMessage({ error: true, text: storageTranslator.current('quickApps.storageFailed', { message: cause.message }) }) })
  }, [view])
  useEffect(() => {
    if (!dirty || typeof window === 'undefined') return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty])
  const run = async <T,>(operation: () => Promise<T>, apply: (value: T) => void) => {
    if (pending.current || busy) return
    const current = generation.current
    pending.current = true; setLoading(true); setMessage(null)
    try { const value = await operation(); if (current === generation.current) apply(value) }
    catch (cause) {
      if (current !== generation.current) return
      const code = (cause as { code?: string }).code
      const text = code === 'QUICK_APP_CONFLICT' ? t('quickApps.documentConflict')
        : ['QUICK_APP_REVOKED', 'QUICK_APP_LAUNCH_EXPIRED', 'QUICK_APP_ACCESS_DENIED'].includes(code ?? '') ? t('quickApps.documentAccessExpired')
          : code === 'CODINGNS_RPC_NOT_FOUND' ? t('quickApps.documentHostUpdate') : cause instanceof Error ? cause.message : String(cause)
      setMessage({ error: true, text })
    } finally { if (current === generation.current) { pending.current = false; setLoading(false) } }
  }
  const call = <T,>(operation: string, extra: Record<string, unknown> = {}) => client!.call<T>('document', { id: view.launchId, path, operation, ...extra })
  const guard = (action: () => void) => {
    if (pending.current || busy) return
    if (dirty) setConfirmation({ kind: 'discard', action }); else action()
  }
  const save = () => {
    if (!doc?.canWrite || !dirty) return
    const content = draft
    void run(() => call<QuickAppDocument>('save', { content, version: doc.version }), next => {
      // Typing can continue while saving; never overwrite edits made after the submitted snapshot.
      setDoc(next); setMessage({ error: false, text: t('quickApps.documentSaved') })
    })
  }
  const reload = () => guard(() => {
    if (doc && client && view.launchId) void run(() => call<QuickAppDocument>('read'), next => { accept(next); setMode(defaultMode(next.path)) })
    else { setFrameLoading(view.kind === 'html'); onReload() }
  })
  const navigate = (destination: string, absolute = false) => guard(() => {
    const target = absolute ? destination : documentPath(app.documentRoot, path, destination)
    if (!target) { setMessage({ error: true, text: t('quickApps.documentLinkDenied') }); return }
    if (!client || !view.launchId) { setMessage({ error: true, text: t('quickApps.documentHostUpdate') }); return }
    void run(() => call<QuickAppDocument>('read', { path: target }), next => { accept(next); setMode(defaultMode(next.path)) })
  })
  const edit = () => {
    if (!client || !view.launchId || !doc?.version) { setMessage({ error: true, text: t('quickApps.documentHostUpdate') }); return }
    if (doc.canWrite) setMode('edit'); else setConfirmation({ kind: 'edit' })
  }
  const approve = () => {
    setConfirmation(null)
    void run(async () => { await call('allow-edit'); return call<QuickAppDocument>('read') }, next => { accept(next); setMode('edit') })
  }
  const disabled = busy || loading
  const tool = (label: string, icon: ReturnType<typeof resolveRefreshIcon>, action: () => void, options: { disabled?: boolean; pressed?: boolean } = {}) =>
    h(DshTooltip, { label, side: 'bottom', align: 'end', portal: true, delayMs: 500, focusDelayMs: 500, children: h('button', {
      type: 'button', className: 'qa-view-tool', 'aria-label': label, 'aria-pressed': options.pressed,
      disabled: options.disabled, onClick: action,
    }, h(icon, { size: 15 })) })
  // A bootstrap URL is a credential, not an address to copy into another browsing context.
  const address = view.kind === 'html' ? view.isolation === 'sandbox-proxy' ? app.entryPath : `${view.origin}/${app.entryPath.slice(app.documentRoot.length).replace(/^\//u, '').split('/').map(encodeURIComponent).join('/')}` : ''
  const activeMode = mode === 'markdown' ? t('quickApps.markdown') : mode === 'edit' ? t('quickApps.edit') : t('quickApps.source')
  return h(DshModal, { open: true, headless: true, title: app.title, onClose: () => guard(onClose),
    className: `codingns-quick-app-dialog qa-viewer${maximized ? ' qa-maximized' : ''}` },
    h('section', { className: `qa-view-surface qa-view-${view.kind}`, 'aria-busy': disabled },
      h('header', { className: 'qa-view-titlebar' },
        h('div', { className: 'qa-view-title' }, h(DshFileTypeIcon, { kind: classifyDshFileType(path), size: 16 }),
          h('h2', null, app.title), dirty ? h('span', { className: 'qa-document-dirty', title: t('quickApps.unsaved'), 'aria-label': t('quickApps.unsaved') }, '●') : null),
        tool(t(maximized ? 'quickApps.restore' : 'quickApps.maximize'), resolveViewerIcon(maximized ? 'restore' : 'fullscreen'), () => setMaximized(!maximized), { pressed: maximized }),
        tool(t('quickApps.back'), resolveAssistantControlIcon('close'), () => guard(onClose), { disabled })),
      h('div', { className: 'qa-view-toolbar', role: 'group', 'aria-label': t('quickApps.viewerTools') },
        doc ? h(DshPathLabel, { path, className: 'qa-view-path' })
          : h('input', { className: 'qa-view-address', value: address, readOnly: true, 'aria-label': t('quickApps.entryAddress'), title: address }),
        doc ? h(DshMenu, { open: menu, onClose: () => setMenu(false), align: 'end', portal: true, dense: true,
          anchor: h('button', { type: 'button', className: 'qa-view-mode', disabled, 'aria-label': t('quickApps.viewMode'), onClick: () => setMenu(!menu) }, activeMode),
          selectedId: mode, items: [...(defaultMode(path) === 'markdown' ? [{ id: 'markdown', label: t('quickApps.markdown') }] : []), { id: 'source', label: t('quickApps.source') }, { id: 'edit', label: t('quickApps.edit') }],
          onSelect: value => { setMenu(false); if (value === 'edit') edit(); else setMode(value as DocumentMode) } }) : null,
        doc && mode === 'source' ? tool(t('quickApps.wrapText'), resolveTextWrapIcon(wrap), () => setWrap(!wrap), { pressed: wrap }) : null,
        doc && path !== app.entryPath ? tool(t('quickApps.documentHome'), resolveViewerIcon('back'), () => navigate(app.entryPath, true), { disabled }) : null,
        doc ? dirty ? tool(t('quickApps.save'), resolveViewerIcon('save'), save, { disabled })
          : tool(t('quickApps.edit'), resolveViewerIcon('edit'), edit, { disabled: disabled || mode === 'edit' }) : null,
        tool(t('quickApps.reloadView'), resolveRefreshIcon(), reload, { disabled })),
      disabled || frameLoading ? h('div', { className: 'qa-view-progress', role: 'status', 'aria-label': t('quickApps.loadingDocument') }) : null,
      error || message ? h('p', { className: message && !message.error && !error ? 'qa-view-status' : 'qa-view-error', role: message && !message.error && !error ? 'status' : 'alert' }, error ?? message?.text) : null,
      doc && /\.(?:md|markdown)$/iu.test(path) && !hasNativeMarkdown() ? h('p', { className: 'qa-view-status', role: 'status' }, t('quickApps.markdownUnavailable')) : null,
      view.kind === 'html' && view.isolation === 'sandbox-proxy' ? h('p', { className: 'qa-view-status', role: 'status' }, t(view.storageToken ? 'quickApps.storagePreview' : 'quickApps.sandboxPreview')) : null,
      doc ? mode === 'edit' ? h(QuickAppEditor, { key: path, content: draft, path, t, onChange: setDraft, onSave: save })
        : mode === 'markdown' ? h(QuickAppMarkdown, { key: path, content: draft, path, root: app.documentRoot, launchId: view.launchId, client, t, onNavigate: navigate })
          : h('div', { className: 'qa-view-text-body', 'data-wrap': wrap, tabIndex: 0, 'aria-label': app.title }, h('pre', null, draft))
        : view.kind === 'html' ? h('iframe', { ref: frame, key: view.launchId, className: 'qa-view-frame', title: app.title, src: view.url, onLoad: () => setFrameLoading(false),
          sandbox: view.isolation === 'sandbox-proxy' ? 'allow-scripts allow-forms allow-downloads' : 'allow-scripts allow-same-origin allow-forms allow-downloads', referrerPolicy: 'no-referrer' }) : null),
    confirmation ? h(DshModal, { open: true, title: t(confirmation.kind === 'edit' ? 'quickApps.allowEditing' : 'quickApps.discardTitle'), closeLabel: t('quickApps.cancel'),
      onClose: () => setConfirmation(null), className: 'codingns-quick-app-dialog qa-view-confirm',
      footer: h(QuickAppActions, null, h(QuickAppButton, { onClick: () => setConfirmation(null) }, t('quickApps.cancel')),
        h(QuickAppButton, { danger: confirmation.kind === 'discard', onClick: () => { if (confirmation.kind === 'edit') approve(); else { setConfirmation(null); confirmation.action() } } },
          t(confirmation.kind === 'edit' ? 'quickApps.allowEditing' : 'quickApps.discard'))) },
      h('p', null, t(confirmation.kind === 'edit' ? 'quickApps.allowEditingHelp' : 'quickApps.discardHelp', { path }))) : null)
}
