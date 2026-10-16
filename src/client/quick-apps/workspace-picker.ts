import { createElement as h, useEffect, useId, useState } from 'react'
import type { NativeWorkspaceRecord } from '../native-workspace-store.js'
import type { CodingNsTranslator } from '../locale.js'
import { DshFolderIcon, DshMenu, resolveChevronDownIcon } from '../../dsh-capabilities/client/primitives-adapter.js'

export const workspaceChoiceId = (workspace: { hostId?: string | undefined; workspaceId: string }) => JSON.stringify([workspace.hostId ?? 'local', workspace.workspaceId])

/** The native menu owns placement, keyboard navigation and focus return. IDs never depend on list order. */
export function QuickAppWorkspacePicker({ workspaces, hostId, workspaceId, disabled, error, t, onSelect }: {
  workspaces: readonly NativeWorkspaceRecord[]; hostId: string; workspaceId: string; disabled: boolean
  error?: string | undefined; t: CodingNsTranslator; onSelect(workspace: NativeWorkspaceRecord): void
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const selectedId = workspaceChoiceId({ hostId, workspaceId })
  const selected = workspaces.find(item => workspaceChoiceId(item) === selectedId)
  const label = (workspace: NativeWorkspaceRecord) => h('span', { className: 'qa-workspace-label' },
    h('span', { className: 'qa-workspace-name' }, workspace.title),
    h('small', null, `${workspace.hostLabel ?? workspace.hostId ?? t('quickApps.localHost')}${workspace.workspacePath ?? workspace.path ? ` · ${workspace.workspacePath ?? workspace.path}` : ''}`))
  return h('div', { className: 'qa-field' }, h('label', { htmlFor: id }, t('quickApps.workspace')),
    h(DshMenu, { open: open && !disabled, portal: true, autoFocus: true, className: 'qa-workspace-picker', listClassName: 'codingns-quick-app-workspaces', selectedId,
      anchor: h('button', { id, type: 'button', className: 'qa-workspace-trigger', disabled, 'aria-label': t('quickApps.workspace'), 'aria-invalid': Boolean(error),
        'aria-haspopup': 'menu', 'aria-expanded': open && !disabled, 'data-modal-autofocus': true,
        onClick: () => setOpen(!open), onKeyDown: (event: { key: string; preventDefault(): void }) => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true) } } },
      h(DshFolderIcon, { size: 18 }), selected ? label(selected) : h('span', { className: 'qa-workspace-label' }, t(workspaceId ? 'quickApps.status.missing-workspace' : 'quickApps.chooseWorkspace')),
      h(resolveChevronDownIcon(), { size: 14 })),
      items: workspaces.length ? workspaces.map(workspace => ({ id: workspaceChoiceId(workspace), label: label(workspace), icon: h(DshFolderIcon, { size: 16 }) }))
        : [{ id: 'empty', label: t('quickApps.noWorkspaces'), disabled: true }],
      onClose: () => setOpen(false), onSelect: (value: string) => {
        const workspace = workspaces.find(item => workspaceChoiceId(item) === value)
        if (disabled || !workspace) return
        setOpen(false); onSelect(workspace)
      } }), error ? h('span', { className: 'qa-field-error', role: 'alert' }, error) : null)
}
