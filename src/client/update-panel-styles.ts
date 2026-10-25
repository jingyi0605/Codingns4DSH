import { dshThemeColor } from './theme.js'

const STYLE_ID = 'codingns4dsh-update-panel'

export const updatePanelClass = {
  root: 'codingns4dsh-update-panel',
  section: 'codingns4dsh-update-section',
  versions: 'codingns4dsh-update-versions',
  version: 'codingns4dsh-update-version',
  versionLabel: 'codingns4dsh-update-version-label',
  versionValue: 'codingns4dsh-update-version-value',
  note: 'codingns4dsh-update-note',
  warning: 'codingns4dsh-update-warning',
  controls: 'codingns4dsh-update-controls',
  fieldLabel: 'codingns4dsh-update-field-label',
  state: 'codingns4dsh-update-state',
  stateGood: 'codingns4dsh-update-state-good',
  stateBad: 'codingns4dsh-update-state-bad',
  target: 'codingns4dsh-update-target',
  targetHeader: 'codingns4dsh-update-target-header',
  targetVersion: 'codingns4dsh-update-target-version',
  metadata: 'codingns4dsh-update-metadata',
  metadataItem: 'codingns4dsh-update-metadata-item',
  metadataLabel: 'codingns4dsh-update-metadata-label',
  metadataValue: 'codingns4dsh-update-metadata-value',
  notes: 'codingns4dsh-update-notes',
  notesBody: 'codingns4dsh-update-notes-body',
  actions: 'codingns4dsh-update-actions',
  confirm: 'codingns4dsh-update-confirm',
  operation: 'codingns4dsh-update-operation',
} as const

export function installUpdatePanelStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return () => undefined
  const style = document.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = `
.${updatePanelClass.root}{display:flex;flex-direction:column;gap:14px;color:${dshThemeColor.labelPrimary};font-size:13px;line-height:1.45;min-width:0}
.${updatePanelClass.section}{display:flex;flex-direction:column;gap:9px;min-width:0}
.${updatePanelClass.versions}{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.${updatePanelClass.version}{display:flex;flex-direction:column;gap:3px;min-width:0;padding:8px 10px;border:1px solid ${dshThemeColor.border};border-radius:8px;background:${dshThemeColor.surfaceSubtle}}
.${updatePanelClass.versionLabel},.${updatePanelClass.metadataLabel}{color:${dshThemeColor.labelSecondary};font-size:11px;line-height:1.3}
.${updatePanelClass.versionValue}{font-size:13px;font-weight:650;overflow-wrap:anywhere;font-family:${dshThemeColor.codeFont}}
.${updatePanelClass.note}{margin:0;padding:9px 11px;border-left:3px solid ${dshThemeColor.accent};border-radius:6px;background:${dshThemeColor.surfaceSubtle};color:${dshThemeColor.labelSecondary};font-size:12px}
.${updatePanelClass.warning}{margin:0;padding:9px 11px;border-left:3px solid ${dshThemeColor.warning};border-radius:6px;background:color-mix(in srgb,${dshThemeColor.warning} 10%,transparent);font-size:12px}
.${updatePanelClass.controls}{display:flex;flex-direction:column;gap:6px}
.${updatePanelClass.fieldLabel}{color:${dshThemeColor.labelSecondary};font-size:11px;font-weight:650}
.${updatePanelClass.state}{margin:0;padding:8px 10px;border-radius:7px;background:${dshThemeColor.surfaceSubtle};font-weight:650}
.${updatePanelClass.stateGood}{color:${dshThemeColor.success};border:1px solid color-mix(in srgb,${dshThemeColor.success} 40%,transparent)}
.${updatePanelClass.stateBad}{color:${dshThemeColor.error};border:1px solid color-mix(in srgb,${dshThemeColor.error} 40%,transparent)}
.${updatePanelClass.target}{display:flex;flex-direction:column;gap:10px;padding:11px;border:1px solid ${dshThemeColor.border};border-radius:9px;background:${dshThemeColor.cardBackground};box-shadow:${dshThemeColor.subtleShadow}}
.${updatePanelClass.targetHeader}{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0}
.${updatePanelClass.targetVersion}{color:${dshThemeColor.accent};font-size:16px;line-height:1.25;font-weight:750;font-family:${dshThemeColor.codeFont};overflow-wrap:anywhere}
.${updatePanelClass.metadata}{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px}
.${updatePanelClass.metadataItem}{display:flex;flex-direction:column;gap:2px;min-width:0}
.${updatePanelClass.metadataValue}{font-size:12px;overflow-wrap:anywhere}
.${updatePanelClass.notes}{display:flex;flex-direction:column;gap:6px;min-width:0}
.${updatePanelClass.notesBody}{box-sizing:border-box;max-height:280px;margin:0;padding:10px 11px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid ${dshThemeColor.border};border-radius:7px;background:${dshThemeColor.inputBackground};font-family:${dshThemeColor.codeFont};font-size:12px;line-height:1.55}
.${updatePanelClass.actions}{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.${updatePanelClass.confirm}{padding:11px;border:1px solid color-mix(in srgb,${dshThemeColor.warning} 50%,${dshThemeColor.border});border-radius:9px;background:color-mix(in srgb,${dshThemeColor.warning} 7%,transparent)}
.${updatePanelClass.operation}{padding:11px;border:1px solid ${dshThemeColor.border};border-radius:9px;background:${dshThemeColor.surfaceSubtle}}
@media(max-width:640px){.${updatePanelClass.versions}{grid-template-columns:1fr}.${updatePanelClass.metadata}{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.codingns4dsh-update-panel *{scroll-behavior:auto}}
`
  document.head.appendChild(style)
  return () => style.remove()
}
