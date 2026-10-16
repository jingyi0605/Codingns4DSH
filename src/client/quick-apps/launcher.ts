import { createElement as h, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { CodingNsClientServices } from '../features/types.js'
import type { QuickApp, QuickAppAvailability, QuickAppRuntimeReason } from '../../shared/contracts/quick-apps.js'
import { QUICK_APP_RUNTIME_REASONS, quickAppTransportErrorCode } from '../../shared/contracts/quick-apps.js'
import { DshFileTypeIcon, DshFolderIcon, DshInput, DshModal, classifyDshFileType } from '../../dsh-capabilities/client/primitives-adapter.js'
import { useCodingNsTranslator } from '../locale.js'
import { readNativeWorkspaceSnapshot, readNativeWorkspaceListStore } from '../native-workspace-store.js'
import { QuickAppsClient, type QuickAppView } from './client.js'
import { draftChanged, entryTitle, newQuickAppDraft, quickAppEntryPatch, shortcutIcon, type QuickAppDraft } from './presentation.js'
import { QuickAppActions, QuickAppButton, QuickAppControlIcon, QuickAppField } from './ui.js'
import { quickAppsCss } from './styles.js'
import { QuickAppWorkspacePicker } from './workspace-picker.js'
import { QuickAppFilePicker } from './file-picker.js'
import { QuickAppViewer } from './viewer.js'
import { useQuickAppReorder } from './reorder.js'
import { sidebarFooterControlStyle, useSidebarFooterAlignment } from '../sidebar-footer-style.js'

type ListedApp = QuickApp & { availability: QuickAppAvailability; runtimeReason?: QuickAppRuntimeReason }
type Screen = { kind: 'edit'; draft: QuickAppDraft }
  | { kind: 'remove'; app: QuickApp; returnToEdit?: boolean } | { kind: 'view'; app: QuickApp; view: QuickAppView }
type Notice = { tone: 'error' | 'success'; text: string }

export function QuickAppsLauncher({ services, wide }: { services: CodingNsClientServices; wide: boolean }): ReactElement {
  const rail = useSidebarFooterAlignment(wide)
  const t = useCodingNsTranslator(services.locale)
  const formId = useId()
  const client = useMemo(() => new QuickAppsClient(services.rpc), [services.rpc])
  const [screen, setScreen] = useState<Screen | null>(null)
  const [mode, setMode] = useState<'normal' | 'edit' | 'collapsed'>('normal')
  const editing = mode === 'edit'
  const collapsed = mode === 'collapsed'
  const [pickingFile, setPickingFile] = useState(false)
  const [apps, setApps] = useState<ListedApp[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const operationId = useRef(0)
  const running = useRef(false)
  const [workspaces, setWorkspaces] = useState(() => readNativeWorkspaceSnapshot(services.uiContext)?.items ?? [])
  useEffect(() => {
    const update = () => setWorkspaces(readNativeWorkspaceSnapshot(services.uiContext)?.items ?? [])
    update()
    return readNativeWorkspaceListStore(services.uiContext)?.subscribe(update)
  }, [services.uiContext])

  const perform = async (operation: (current: () => boolean) => Promise<void>) => {
    if (running.current) return
    const id = ++operationId.current
    const current = () => operationId.current === id
    running.current = true; setBusy(true); setNotice(null)
    try { await operation(current) } catch (error) {
      if (!current()) return
      const code = (error as { code?: string }).code
      const reason = QUICK_APP_RUNTIME_REASONS.find(reason => code === quickAppTransportErrorCode(reason))
      const text = reason ? t(`quickApps.runtime.${reason}`) : code === 'QUICK_APP_ORIGIN_UNAVAILABLE' ? t('quickApps.unavailable')
        : code === 'QUICK_APP_WORKSPACE_ACCESS_UNAVAILABLE' ? t('quickApps.workspaceAccessUnavailable')
        : code === 'QUICK_APP_RELAY_UNAVAILABLE' ? t('quickApps.status.unsupported-connection')
          : code === 'QUICK_APP_CONFLICT' ? t('quickApps.conflict') : error instanceof Error ? error.message : String(error)
      setNotice({ tone: 'error', text })
    } finally { if (current()) { running.current = false; setBusy(false) } }
  }
  const refresh = async (current: () => boolean) => {
    const next = await client.call<ListedApp[]>('list')
    if (current()) { setApps(next); setLoaded(true) }
  }
  useEffect(() => {
    setApps([]); setLoaded(false); setScreen(null); setPickingFile(false)
    void perform(refresh)
    return () => { operationId.current++; running.current = false; void client.close().catch(() => undefined) }
  }, [client])
  const navigate = (next: Screen) => { setScreen(next); setPickingFile(false); setNotice(null); setErrors({}) }
  const close = () => {
    operationId.current++; running.current = false; setBusy(false); setScreen(null); setPickingFile(false); setNotice(null); setErrors({})
    void client.close().catch(() => undefined)
  }
  const edit = (app: QuickApp) => navigate({ kind: 'edit', draft: { ...app, expectedRevision: app.revision } })
  const add = () => {
    const draft = newQuickAppDraft(apps.length)
    // A single managed workspace is unambiguous; otherwise require an explicit choice.
    const workspace = workspaces.length === 1 ? workspaces[0] : undefined
    navigate({ kind: 'edit', draft: { ...draft, workspaceId: workspace?.workspaceId ?? '', hostId: workspace?.hostId ?? 'local' } })
  }
  const updateDraft = (patch: Partial<QuickAppDraft>) => {
    setScreen(current => current?.kind === 'edit' ? { ...current, draft: { ...current.draft, ...patch } } : current)
    setErrors({})
  }
  const button = (label: string, onClick: () => void, danger = false) => h(QuickAppButton, { disabled: busy, onClick, danger }, label)
  const setEntry = (draft: QuickAppDraft, value: string) => updateDraft(quickAppEntryPatch(draft, value, apps.find(app => app.id === draft.id)))
  const field = (name: 'title' | 'entryPath', draft: QuickAppDraft) => {
    const id = `${formId}-${name}`
    const input = h(DshInput, { id, className: 'qa-input', value: draft[name], disabled: busy, 'aria-invalid': Boolean(errors[name]), 'aria-describedby': `${id}-help`,
      icon: name === 'entryPath' ? h(DshFileTypeIcon, { kind: classifyDshFileType(draft.entryPath), size: 16 }) : undefined,
      placeholder: name === 'title' ? entryTitle(draft.entryPath) : t('quickApps.entryPlaceholder'),
      onChange: (event: { target: { value: string } }) => name === 'entryPath' ? setEntry(draft, event.target.value) : updateDraft({ [name]: event.target.value }) })
    return h(QuickAppField, { id, label: t(name === 'title' ? 'quickApps.titleField' : `quickApps.${name}`), error: errors[name],
      help: t(name === 'title' ? 'quickApps.titleHelp' : 'quickApps.entryHelp'),
    }, name === 'entryPath' ? h('div', { className: 'qa-file-input' }, input,
      h(QuickAppButton, { className: 'qa-browse', icon: h(DshFolderIcon, { size: 16 }),
        disabled: busy || !workspaces.some(item => item.workspaceId === draft.workspaceId && (item.hostId ?? 'local') === draft.hostId), onClick: () => setPickingFile(true) }, t('quickApps.browse'))) : input)
  }

  const save = (draft: QuickAppDraft) => {
    const invalid: Record<string, string> = {}
    if (!workspaces.some(workspace => workspace.workspaceId === draft.workspaceId && (workspace.hostId ?? 'local') === draft.hostId)) invalid.workspaceId = t('quickApps.chooseWorkspace')
    if (!draft.entryPath.trim()) invalid.entryPath = t('quickApps.entryRequired')
    if (Object.keys(invalid).length) { setErrors(invalid); return }
    void perform(async current => {
      const saved = await client.call<QuickApp>('upsert', { app: { ...draft, fileAccess: draft.kind === 'html' ? 'workspace' : undefined,
        title: draft.title.trim() || entryTitle(draft.entryPath) }, expectedRevision: draft.expectedRevision })
      if (draft.kind === 'html' && saved.fileAccess !== 'workspace') throw new Error(t('quickApps.workspaceAccessHostUpdate'))
      if (!current()) return
      setScreen(null)
      await refresh(current)
      if (current()) setNotice({ tone: 'success', text: t('quickApps.saved') })
    })
  }

  const reorder = useQuickAppReorder({ apps, enabled: editing && !busy && !screen, onReorder: ordered => {
    void perform(async current => {
      setApps([...ordered])
      try {
        const saved = await client.reorder(ordered, current)
        if (!current()) return
        const previous = new Map(apps.map(app => [app.id, app]))
        setApps(saved.map(app => ({ ...previous.get(app.id)!, ...app })))
        setNotice({ tone: 'success', text: t('quickApps.reordered') })
      } catch (error) {
        // Legacy Hosts save individual shortcuts; reconcile any completed writes before retrying.
        if (current()) {
          try { await refresh(current) } catch { if (current()) { setApps(apps); setLoaded(false) } }
        }
        throw error
      }
    })
  } })

  let body: ReactNode = null
  let footer: ReactNode = null
  let title = t('quickApps.title')
  if (screen?.kind === 'edit') {
    const { draft } = screen
    const original = apps.find(app => app.id === draft.id)
    const changed = original !== undefined && draftChanged(draft, original)
    title = t(draft.id ? 'quickApps.editShortcut' : 'quickApps.add')
    const selected = workspaces.find(workspace => workspace.workspaceId === draft.workspaceId && (workspace.hostId ?? 'local') === draft.hostId)
    body = h('form', { id: formId, className: 'qa-form', onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); save(draft) } },
      h(QuickAppWorkspacePicker, { workspaces, workspaceId: draft.workspaceId, hostId: draft.hostId, disabled: busy, error: errors.workspaceId, t, onSelect: workspace => {
        if (workspace.workspaceId === draft.workspaceId && (workspace.hostId ?? 'local') === draft.hostId) return
        setPickingFile(false)
        updateDraft({ workspaceId: workspace.workspaceId, hostId: workspace.hostId ?? 'local', entryPath: '', documentRoot: '', mounts: [], spaFallback: false })
      } }),
      field('entryPath', draft), field('title', draft),
      pickingFile && selected ? h(QuickAppFilePicker, { key: `${draft.hostId}:${draft.workspaceId}`, client, workspace: selected, value: draft.entryPath, t,
        onClose: () => setPickingFile(false), onSelect: path => { setEntry(draft, path); setPickingFile(false) } }) : null,
      h(QuickAppField, { id: `${formId}-kind`, label: t('quickApps.kind') }, h('select', { id: `${formId}-kind`, className: 'qa-select', value: draft.kind, disabled: busy, onChange: (event: { target: { value: string } }) => updateDraft({ kind: event.target.value as 'html' | 'text' }) },
        h('option', { value: 'html' }, t('quickApps.html')), h('option', { value: 'text' }, t('quickApps.text')))),
      draft.kind === 'html' && selected ? h('p', { className: 'qa-help' }, t('quickApps.workspaceAccessHelp', { workspace: selected.title })) : null,
      draft.id ? h('fieldset', { className: 'qa-management', disabled: busy || changed, 'aria-label': t('quickApps.accessAndRemoval') },
        changed ? h('p', { className: 'qa-help' }, t('quickApps.saveBeforeAccess')) : null,
        h(QuickAppActions, null,
          draft.kind === 'html' ? button(t('quickApps.revoke'), () => { void perform(async current => {
            const result = await client.call<{ app?: QuickApp }>('revoke', { id: draft.id })
            if (!current()) return
            if (result.app) edit(result.app)
            await refresh(current)
            if (current()) setNotice({ tone: 'success', text: t('quickApps.revoked') })
          }) }, true) : null,
          button(t('quickApps.remove'), () => { const app = apps.find(item => item.id === draft.id); if (app) navigate({ kind: 'remove', app, returnToEdit: true }) }, true))) : null)
    footer = h(QuickAppActions, null, button(t('quickApps.cancel'), close), h(QuickAppButton, { type: 'submit', form: formId, disabled: busy, variant: 'primary' },
      t(draft.kind === 'html' && draft.fileAccess !== 'workspace' ? 'quickApps.saveWorkspaceAccess' : 'quickApps.save')))
  } else if (screen?.kind === 'remove') {
    title = t('quickApps.remove')
    body = h('div', { className: 'qa-form' }, h('strong', null, screen.app.title), h('p', { className: 'qa-help' }, t('quickApps.removeHelp')))
    footer = h(QuickAppActions, null, button(t('quickApps.cancel'), () => screen.returnToEdit ? edit(screen.app) : close()), button(t('quickApps.remove'), () => { void perform(async current => {
      await client.call('remove', { id: screen.app.id, expectedRevision: screen.app.revision })
      if (current()) { setScreen(null); await refresh(current) }
    }) }, true))
  } else if (screen?.kind === 'view') {
    title = screen.app.title
  }
  const control = (label: string, icon: 'add' | 'edit' | 'done' | 'retry' | 'collapse' | 'expand', onClick: () => void) => h('button', {
    type: 'button', className: 'qa-control', style: sidebarFooterControlStyle, title: label, 'aria-label': label, disabled: busy,
    'aria-pressed': icon === 'edit' || icon === 'done' ? editing : undefined,
    'aria-expanded': icon === 'collapse' || icon === 'expand' ? !collapsed : undefined, onClick,
  }, h(QuickAppControlIcon, { icon }))
  return h('section', { ref: rail, className: 'codingns-quick-app-rail', 'data-wide': wide, 'data-collapsed': collapsed, 'aria-label': t('quickApps.title'), 'aria-busy': busy }, h('style', null, quickAppsCss),
    h('header', { className: 'qa-rail-header' },
      wide ? h('h2', null, t('quickApps.title')) : null,
      wide && loaded && !collapsed ? h('span', { className: 'qa-count', 'aria-label': t('quickApps.count', { count: apps.length }) }, apps.length) : null,
      h('div', { className: 'qa-controls' },
        !collapsed ? editing ? control(t('quickApps.add'), 'add', add)
          : control(t('quickApps.manage'), 'edit', () => { setMode('edit'); setNotice(null) }) : null,
        collapsed ? control(t('quickApps.expandBar'), 'expand', () => setMode('normal'))
          : editing ? control(t('quickApps.done'), 'done', () => { setMode('normal'); setNotice(null) })
            : control(t('quickApps.collapseBar'), 'collapse', () => setMode('collapsed')))),
    !collapsed ? h('div', { className: 'qa-rail-content' },
      !screen && notice ? h('p', { className: 'qa-rail-notice', role: notice.tone === 'error' ? 'alert' : 'status', title: notice.text }, wide ? notice.text : '!') : null,
      !loaded && !notice ? h('p', { className: 'qa-rail-notice', role: 'status', title: t('quickApps.loading') }, wide ? t('quickApps.loading') : '…') : null,
      !screen && (!loaded || notice?.tone === 'error') && !busy ? control(t('quickApps.retry'), 'retry', () => { void perform(refresh) }) : null,
      loaded && !apps.length && wide ? h('p', { className: 'qa-rail-notice' }, t('quickApps.empty')) : null,
      h('div', { className: 'qa-grid', ...reorder.gridProps }, ...reorder.apps.map(app => {
        const icon = shortcutIcon(app)
        const workspace = workspaces.find(item => item.workspaceId === app.workspaceId && (item.hostId ?? 'local') === app.hostId)
        const available = app.availability === 'available'
        const status = available ? '' : app.availability === 'unsupported-runtime' && app.runtimeReason
          ? t(`quickApps.runtime.${app.runtimeReason}`) : t(`quickApps.status.${app.availability}`)
        return h('div', { key: app.id, className: 'qa-shortcut', 'data-quick-app-id': app.id }, h('button', { type: 'button', className: 'qa-tile', 'data-editing': editing, ...reorder.tileProps(app.id),
          disabled: busy, 'data-unavailable': !available,
          'aria-label': `${t(editing ? 'quickApps.editNamed' : 'quickApps.openNamed', { title: app.title })}${status ? `. ${status}` : ''}`,
          title: `${app.title}\n${workspace?.hostLabel ?? app.hostId} · ${workspace?.title ?? app.workspaceId}\n${app.entryPath}${status ? `\n${status}` : ''}${editing ? `\n${t('quickApps.reorderHelp')}` : ''}`,
          onClick: () => {
            if (editing) { edit(app); return }
            if (!available) { setNotice({ tone: 'error', text: status }); return }
            void perform(async current => { const view = await client.open(app.id); if (current() && view) navigate({ kind: 'view', app, view }) })
          } }, h('span', { className: 'qa-icon', style: icon.style, 'aria-hidden': true }, icon.text,
            !available ? h('span', { className: 'qa-unavailable' }, '!') : null), h('strong', null, app.title)),
          editing ? h('button', { type: 'button', className: 'qa-remove', disabled: busy,
            title: t('quickApps.removeNamed', { title: app.title }), 'aria-label': t('quickApps.removeNamed', { title: app.title }),
            onClick: () => navigate({ kind: 'remove', app }),
          }, h(QuickAppControlIcon, { icon: 'remove' })) : null)
      }))) : null,
    screen?.kind === 'view' ? h(QuickAppViewer, { key: screen.app.id, app: screen.app, view: screen.view, client, busy, error: notice?.tone === 'error' ? notice.text : undefined, t, onClose: close,
        onReload: () => { void perform(async current => { const view = await client.open(screen.app.id); if (current() && view) setScreen({ ...screen, view }) }) } })
      : screen ? h(DshModal, { open: true, title, closeLabel: t('quickApps.close'), onClose: close, className: 'codingns-quick-app-dialog', contentClassName: 'qa-content', footer },
      h('div', { className: 'qa-body', 'aria-busy': busy }, notice ? h('div', { className: 'qa-notice', role: notice.tone === 'error' ? 'alert' : 'status' }, notice.text) : null, body)) : null)
}
