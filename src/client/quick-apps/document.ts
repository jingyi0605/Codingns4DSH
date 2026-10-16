import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { RootContent } from 'mdast'
import { DshMarkdownText, DshMarkdownDelegate } from '../../dsh-capabilities/client/primitives-adapter.js'
import type { CodingNsTranslator } from '../locale.js'
import { attachLoadedEngine, createEngineLoader } from '../engine-loader.js'
import type { QuickAppsClient } from './client.js'

const loadEditor = createEngineLoader(() => import('../editor-engine.js'))

/** Resolve authored relative paths without allowing the document to nominate another root. */
export function documentPath(root: string, current: string, value: string): string | undefined {
  if (/%(?:2f|5c|25)/iu.test(value)) return undefined
  try { value = decodeURIComponent(value) } catch { return undefined }
  if (/[\\\x00-\x1f\x7f:%?#]/u.test(value) || value.startsWith('//')) return undefined
  const parts = value.split('/').filter(part => part !== '.' && part !== '')
  if (!parts.length || parts.some(part => part === '..' || /[. ]$/u.test(part))) return undefined
  const base = value.startsWith('/') ? root : current.slice(0, Math.max(0, current.lastIndexOf('/')))
  const path = [base, ...parts].filter(Boolean).join('/')
  return root === '' || path.startsWith(`${root}/`) ? path : undefined
}

export function QuickAppEditor({ content, path, t, onChange, onSave }: {
  content: string; path: string; t: CodingNsTranslator; onChange(content: string): void; onSave(): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const change = useRef(onChange); change.current = onChange
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setError(false)
    const abort = new AbortController()
    const dispose = attachLoadedEngine(loadEditor, abort.signal, engine => {
      const view = engine.createFileEditor(host.current!, content, path, value => change.current(value))
      view.contentDOM.setAttribute('aria-label', t('quickApps.documentEditor'))
      view.focus()
      return () => view.destroy()
    }, () => setError(true))
    return () => { abort.abort(); dispose() }
    // The editor owns its in-progress document; typing must not recreate its undo history.
  }, [path, attempt])
  return h('div', { className: 'qa-document-editor', onKeyDownCapture: (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); onSave() }
  } }, error ? h('p', { role: 'alert' }, t('quickApps.editorFailed'), ' ', h('button', { type: 'button', onClick: () => setAttempt(attempt + 1) }, t('quickApps.retry'))) : null,
  h('div', { ref: host, className: 'qa-editor-host' }))
}

export function QuickAppMarkdown({ content, path, root, launchId, client, t, onNavigate }: {
  content: string; path: string; root: string; launchId?: string | undefined; client?: QuickAppsClient | undefined; t: CodingNsTranslator; onNavigate(path: string): void
}) {
  const [images, setImages] = useState<Record<string, string>>({})
  const [missing, setMissing] = useState(false)
  const labels = useMemo(() => ({ code: { copyLabel: t('quickApps.copyCode'), copiedLabel: t('quickApps.copied'),
    toolbarLabels: { codeLabel: t('quickApps.code'), wrapLabel: t('quickApps.wrapText'), unwrapLabel: t('quickApps.unwrapText') } }, footnotes: t('quickApps.footnotes') }), [t])
  const destinations = useMemo(() => {
    const found = new Set<string>()
    const references = new Set<string>()
    const definitions = new Map<string, string>()
    const visit = (node: RootContent): void => {
      if (node.type === 'image') found.add(node.url)
      if (node.type === 'imageReference') references.add(node.identifier.toUpperCase())
      if (node.type === 'definition' && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(), node.url)
      if ('children' in node) node.children.forEach(child => visit(child as RootContent))
    }
    fromMarkdown(content).children.forEach(visit)
    for (const reference of references) { const url = definitions.get(reference); if (url) found.add(url) }
    return [...found].filter(value => !/^https?:\/\//iu.test(value))
  }, [content])
  useEffect(() => {
    let cancelled = false
    setImages({}); setMissing(destinations.length > 32)
    if (!client || !launchId) return
    void (async () => {
      for (let offset = 0; offset < Math.min(32, destinations.length); offset += 4) {
        if (cancelled) return
        await Promise.all(destinations.slice(offset, Math.min(32, offset + 4)).map(async value => {
          try {
            const target = documentPath(root, path, value)
            if (!target) throw new Error('Unsupported document image path')
            const result = await client.call<{ url: string }>('document', { id: launchId, operation: 'image', path: target })
            if (!/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/u.test(result.url)) throw new Error('Invalid document image')
            if (!cancelled) setImages(current => ({ ...current, [value]: result.url }))
          } catch { if (!cancelled) setMissing(true) }
        }))
      }
    })()
    return () => { cancelled = true }
  }, [client, launchId, destinations, path, root])
  const pathImages = useMemo(() => ({ resolve: (value: string) => images[value] }), [images])
  return h('div', { className: 'qa-document-markdown' },
    missing ? h('p', { className: 'qa-help', role: 'status' }, t('quickApps.imagesUnavailable')) : null,
    h(DshMarkdownDelegate, { openFile: value => onNavigate(value), children: h(DshMarkdownText, { text: content, streaming: false, labels, pathImages }) }))
}
