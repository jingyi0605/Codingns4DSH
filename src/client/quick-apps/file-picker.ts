import { createElement as h, useEffect, useRef, useState, type ReactElement } from 'react'
import type { QuickAppDirectory } from '../../shared/contracts/quick-apps.js'
import type { CodingNsTranslator } from '../locale.js'
import type { NativeWorkspaceRecord } from '../native-workspace-store.js'
import { DshFileTypeIcon, DshFolderIcon, DshModal, classifyDshFileType } from '../../dsh-capabilities/client/primitives-adapter.js'
import { QuickAppActions, QuickAppButton } from './ui.js'
import type { QuickAppsClient } from './client.js'

/** A selection dialog over the native Host directory service, independent of conversation tabs. */
export function QuickAppFilePicker({ client, workspace, value, t, onSelect, onClose }: {
  client: QuickAppsClient; workspace: NativeWorkspaceRecord; value: string; t: CodingNsTranslator
  onSelect(path: string): void; onClose(): void
}): ReactElement {
  const [path, setPath] = useState(value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '')
  const [listing, setListing] = useState<QuickAppDirectory | null>(null)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    setLoading(true); setError(''); setListing(null); setSelected('')
    void client.call<QuickAppDirectory>('browse', { hostId: workspace.hostId ?? 'local', workspaceId: workspace.workspaceId, path }).then(next => {
      if (generation.current !== current) return
      setListing(next)
      if (next.entries.some(entry => entry.kind === 'file' && entry.path === value)) setSelected(value)
    }).catch(cause => {
      if (generation.current !== current) return
      const code = (cause as { code?: string })?.code
      // Older Hosts fall through to shortcut lookup for the then-unknown browse operation.
      if (code === 'CODINGNS_RPC_NOT_FOUND' || code === 'QUICK_APP_UNAVAILABLE') setError(t('quickApps.browseHostUpdateRequired'))
      else setError(code === 'QUICK_APP_BROWSE_UNAVAILABLE' ? t('quickApps.browseUnavailable') : cause instanceof Error ? cause.message : String(cause))
    }).finally(() => { if (generation.current === current) setLoading(false) })
    return () => { generation.current++ }
  }, [client, workspace.workspaceId, workspace.hostId, path, revision])
  const choose = (file: string) => { if (!loading && listing?.entries.some(entry => entry.kind === 'file' && entry.path === file)) onSelect(file) }
  const parts = path ? path.split('/') : []
  const entries = [...(listing?.entries ?? [])].sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true }))
  return h(DshModal, { open: true, title: t('quickApps.chooseFile'), closeLabel: t('quickApps.cancel'), onClose,
    className: 'codingns-quick-app-dialog qa-file-picker', contentClassName: 'qa-content',
    footer: h(QuickAppActions, null, h(QuickAppButton, { onClick: onClose }, t('quickApps.cancel')), h(QuickAppButton, { disabled: loading || !selected, onClick: () => choose(selected) }, t('quickApps.useFile'))) },
  h('div', { className: 'qa-body', 'aria-busy': loading },
    h('p', { className: 'qa-help' }, `${workspace.hostLabel ?? workspace.hostId ?? t('quickApps.localHost')} · ${workspace.title}`),
    h('nav', { className: 'qa-file-breadcrumbs', 'aria-label': t('quickApps.currentFolder') },
      h('button', { type: 'button', onClick: () => setPath(''), disabled: !path }, workspace.title),
      ...parts.map((part, index) => h('button', { key: index, type: 'button', disabled: index === parts.length - 1, onClick: () => setPath(parts.slice(0, index + 1).join('/')) }, part)),
      h('button', { type: 'button', disabled: loading, onClick: () => setRevision(revision + 1) }, t('quickApps.refreshFiles'))),
    error ? h('p', { className: 'qa-notice', role: 'alert' }, error) : null,
    h('div', { className: 'qa-file-list', role: 'group', 'aria-label': t('quickApps.chooseFile') },
      loading ? h('p', { className: 'qa-help', role: 'status' }, t('quickApps.loadingFiles')) : !error && !entries.length ? h('p', { className: 'qa-help' }, t('quickApps.emptyFolder')) : null,
      ...entries.map(entry => h('button', { key: entry.path, type: 'button', className: 'qa-file-row', 'data-kind': entry.kind, 'aria-pressed': entry.kind === 'file' ? selected === entry.path : undefined,
        onClick: () => entry.kind === 'directory' ? setPath(entry.path) : setSelected(entry.path), onDoubleClick: () => { if (entry.kind === 'file') choose(entry.path) } },
      entry.kind === 'directory' ? h(DshFolderIcon, { size: 18 }) : h(DshFileTypeIcon, { kind: classifyDshFileType(entry.name), size: 18 }), h('span', null, entry.name)))),
    listing?.truncated ? h('p', { className: 'qa-help', role: 'status' }, t('quickApps.filesTruncated')) : null,
    h('p', { className: 'qa-selected-file' }, selected || t('quickApps.selectFileHint'))))
}
