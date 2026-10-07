const STYLE_ID = 'codingns4dsh-terminal-ui'

export const terminalClass = {
  guideEntry: 'codingns4dsh-terminal-guide-entry',
  guideMain: 'codingns4dsh-terminal-guide-main',
  guideIcon: 'codingns4dsh-terminal-guide-icon',
  guideText: 'codingns4dsh-terminal-guide-text',
  guideTitle: 'codingns4dsh-terminal-guide-title',
  guideDescription: 'codingns4dsh-terminal-guide-description',
  guideTrigger: 'codingns4dsh-terminal-guide-trigger',
  guideMenu: 'codingns4dsh-terminal-guide-menu',
  title: 'codingns4dsh-terminal-title',
  titleInput: 'codingns4dsh-terminal-title-input',
  root: 'codingns4dsh-terminal-root',
  aggregateRoot: 'codingns4dsh-terminal-aggregate-root',
  listDock: 'codingns4dsh-terminal-list-dock',
  list: 'codingns4dsh-terminal-list',
  listTabs: 'codingns4dsh-terminal-list-tabs',
  listActions: 'codingns4dsh-terminal-list-actions',
  newButton: 'codingns4dsh-terminal-new-button',
  refreshButton: 'codingns4dsh-terminal-refresh-button',
  toolsButton: 'codingns4dsh-terminal-tools-button',
  shareButton: 'codingns4dsh-terminal-share-button',
  shareMenu: 'codingns4dsh-terminal-share-menu',
  shareTargetRow: 'codingns4dsh-terminal-share-target-row',
  shareTargetIcon: 'codingns4dsh-terminal-share-target-icon',
  shareTargetTitle: 'codingns4dsh-terminal-share-target-title',
  shareTargetTime: 'codingns4dsh-terminal-share-target-time',
  selectionActions: 'codingns4dsh-terminal-selection-actions',
  selectionError: 'codingns4dsh-terminal-selection-error',
  toolsPanel: 'codingns4dsh-terminal-tools-panel',
  toolAction: 'codingns4dsh-terminal-tool-action',
  toolModifierActive: 'codingns4dsh-terminal-tool-modifier-active',
  listRow: 'codingns4dsh-terminal-list-row',
  listRowSelected: 'codingns4dsh-terminal-list-row-selected',
  listSelect: 'codingns4dsh-terminal-list-select',
  listInput: 'codingns4dsh-terminal-list-input',
  listClose: 'codingns4dsh-terminal-list-close',
  content: 'codingns4dsh-terminal-content',
  empty: 'codingns4dsh-terminal-empty',
  screen: 'codingns4dsh-terminal-screen',
  status: 'codingns4dsh-terminal-status',
  error: 'codingns4dsh-terminal-error',
  cleanupStack: 'codingns4dsh-terminal-cleanup-stack',
  cleanupNotice: 'codingns4dsh-terminal-cleanup-notice',
} as const

/** 安装与 DSH 0.1.6 内置终端相同的布局和主题令牌。 */
export function installTerminalStyles(): () => void {
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_ID}"]`)
  if (existing !== null) return () => undefined
  const style = document.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = terminalCss
  document.head.appendChild(style)
  return () => style.remove()
}

// 修饰键使用主题高亮色；悬停和实际按压时也保持选中态，避免被原生 toolbar 样式覆盖。
// ShortcutKeys 自带灰色文字，选中时让它继承按钮的高对比前景色。
const terminalCss = `
.${terminalClass.guideEntry}{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);border-radius:24px;align-items:stretch;width:100%;display:flex;overflow:hidden}
.${terminalClass.guideMain}{text-align:left;border-radius:24px 0 0 24px;flex:1;justify-content:flex-start;gap:14px;min-width:0;height:auto;min-height:56px;padding:14px 20px}
.${terminalClass.guideIcon}{flex:none}
.${terminalClass.guideText}{flex-direction:column;gap:3px;min-width:0;display:flex}
.${terminalClass.guideTitle}{color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;font-size:15px;line-height:1.4;overflow:hidden}
.${terminalClass.guideDescription}{color:var(--dsw-alias-label-caption);white-space:nowrap;text-overflow:ellipsis;font-size:13px;line-height:1.4;overflow:hidden}
.${terminalClass.guideTrigger}{border-radius:0 24px 24px 0;flex:none;align-self:stretch;width:44px;height:auto;padding:0}
.${terminalClass.guideMenu}{flex:none;align-self:stretch;display:flex}
.${terminalClass.title}{display:inline-flex;align-items:center;gap:6px;line-height:1;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}
.${terminalClass.title}>svg{display:block;flex:none}
.${terminalClass.titleInput}{width:120px;min-width:48px;max-width:100%;color:inherit;font:inherit;background:var(--dsw-alias-bg-l1);border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;outline:none;padding:0 4px}
.${terminalClass.root}{box-sizing:border-box;width:0;height:100%;min-width:0;min-height:0;color:var(--dsw-alias-label-primary);flex-direction:column;flex:1 1 auto;padding-top:8px;font-size:13px;display:flex;overflow:hidden}
.${terminalClass.aggregateRoot}{box-sizing:border-box;width:100%;height:100%;min-width:0;min-height:0;display:flex;flex-direction:column;flex:1 1 auto;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);overflow:hidden}
.${terminalClass.listDock}{box-sizing:border-box;width:100%;min-width:0;flex:none;background:var(--dsw-alias-bg-layer-1);border-bottom:.5px solid var(--dsw-alias-border-l3)}
.${terminalClass.list}{box-sizing:border-box;width:100%;height:40px;min-width:0;min-height:40px;display:flex;align-items:center;gap:2px;padding:3px 8px;background:inherit;overflow-x:auto;overflow-y:hidden;flex:none}
.${terminalClass.listTabs}{box-sizing:border-box;min-width:0;height:34px;display:flex;align-items:center;gap:2px;flex:1 1 auto;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.${terminalClass.listTabs}::-webkit-scrollbar{display:none}
.${terminalClass.listActions}{box-sizing:border-box;display:flex;align-items:center;gap:2px;flex:none;margin-left:4px;padding-left:4px;border-left:.5px solid var(--dsw-alias-border-l3);background:inherit}
.${terminalClass.newButton}{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;align-self:center;width:30px;min-width:30px;height:30px;min-height:30px;max-height:30px;margin:0 0 0 4px;padding:0;white-space:nowrap}
.${terminalClass.refreshButton},.${terminalClass.toolsButton}{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;min-width:30px;height:30px;min-height:30px;max-height:30px;margin:0;padding:0;color:var(--dsw-alias-label-secondary)}
.${terminalClass.shareButton}{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;min-width:30px;height:30px;margin:0;padding:0;color:var(--dsw-alias-label-secondary)}
.${terminalClass.shareButton}:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.${terminalClass.shareMenu}{z-index:10002;width:min(360px,calc(100vw - 24px));max-width:calc(100vw - 24px)}
.${terminalClass.shareMenu} [role="menuitem"]{min-width:0;min-height:32px;font-size:13px;line-height:20px;border-radius:8px}
.${terminalClass.shareMenu} [role="presentation"]{white-space:normal;overflow-wrap:anywhere}
.${terminalClass.shareTargetRow}{display:flex;align-items:center;gap:8px;min-width:0;width:100%}
.${terminalClass.shareTargetIcon}{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;flex:0 0 18px;overflow:hidden;font-size:11px;color:var(--dsw-alias-label-caption)}
.${terminalClass.shareTargetIcon} img{display:block;width:18px;height:18px;object-fit:contain}
.${terminalClass.shareTargetTitle}{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${terminalClass.shareTargetTime}{flex:none;margin-left:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption);white-space:nowrap;font-variant-numeric:tabular-nums}
.${terminalClass.selectionActions}{position:fixed;z-index:10001;display:flex;align-items:center;gap:2px;padding:3px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 4px 16px #0002;max-width:calc(100vw - 16px)}
.${terminalClass.selectionActions} button{white-space:nowrap}
.${terminalClass.selectionError}{max-width:180px;overflow-wrap:anywhere;font-size:12px;padding:0 4px}
.${terminalClass.refreshButton}:hover, .${terminalClass.toolsButton}:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.${terminalClass.toolsButton}[aria-expanded="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.${terminalClass.toolsPanel}{box-sizing:border-box;width:100%;min-width:0;display:flex;align-items:center;gap:4px;padding:4px 8px 6px;border-top:.5px solid var(--dsw-alias-border-l3);overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;overscroll-behavior:contain}
.${terminalClass.toolsPanel}::-webkit-scrollbar{height:5px}
.${terminalClass.toolsPanel}::-webkit-scrollbar-thumb{background:var(--dsw-alias-label-tertiary,#777);border-radius:3px}
.${terminalClass.toolAction}{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:none;width:38px;min-width:38px;height:28px;min-height:28px;padding:0!important;border-radius:var(--dsw-radius-sm,6px)}
.${terminalClass.toolsPanel} .${terminalClass.toolAction}[aria-pressed="true"],.${terminalClass.toolsPanel} .${terminalClass.toolModifierActive},.${terminalClass.toolsPanel} .${terminalClass.toolAction}[aria-pressed="true"]:is(:hover,:active){background:var(--dsw-alias-button-info-fill,#4176e6);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}
.${terminalClass.toolsPanel} .${terminalClass.toolAction}[aria-pressed="true"]>span,.${terminalClass.toolsPanel} .${terminalClass.toolModifierActive}>span{color:inherit}
.${terminalClass.listRow}{box-sizing:border-box;display:flex;align-items:center;height:28px;min-width:110px;max-width:220px;border-radius:var(--dsw-radius-sm,6px);background:transparent;flex:none}
.${terminalClass.listRowSelected}{background:var(--dsw-alias-interactive-bg-hover);box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.08))}
.${terminalClass.listSelect}{box-sizing:border-box;min-width:0;height:28px;min-height:28px;flex:1;text-align:left;color:inherit;border:0;background:transparent;cursor:pointer;padding:0 8px;display:flex;align-items:center;gap:5px;font:inherit;font-size:12px;line-height:20px}
.${terminalClass.listSelect} span{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.${terminalClass.listSelect} small{color:var(--dsw-alias-label-caption);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${terminalClass.listInput}{box-sizing:border-box;min-width:0;height:24px;min-height:24px;flex:1;margin:0 4px;color:inherit;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,6px);padding:0 6px;font:inherit;font-size:12px;line-height:20px}
.${terminalClass.listClose}{box-sizing:border-box;width:28px;height:28px;min-height:28px;padding:0;border:0;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font:inherit;font-size:16px;line-height:20px;flex:none}
.${terminalClass.listClose}:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.${terminalClass.content}{box-sizing:border-box;width:100%;min-width:0;min-height:0;display:flex;flex:1 1 auto;overflow:hidden}
.${terminalClass.empty}{display:flex;flex:1;min-height:0;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--dsw-alias-label-secondary);text-align:center;padding:24px}
.${terminalClass.screen}{box-sizing:border-box;width:100%;min-width:0;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);flex:1 1 auto;padding:0;overflow:hidden}
.${terminalClass.status}{background:var(--dsw-alias-bg-l2);flex-wrap:wrap;align-items:center;gap:8px;padding:5px 12px;display:flex}
.${terminalClass.error}{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-l2);margin:0;padding:10px 12px}
.${terminalClass.cleanupStack}{pointer-events:auto;gap:8px;max-width:min(440px,calc(100vw - 40px));display:grid;position:fixed;bottom:20px;right:20px}
.${terminalClass.cleanupNotice}{border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-l1);overflow-wrap:anywhere;border-radius:8px;align-items:center;gap:12px;padding:12px 16px;font-size:13px;display:flex;box-shadow:0 4px 20px #0002}
.${terminalClass.cleanupNotice} button{border:.5px solid var(--dsw-alias-border-l3);color:inherit;cursor:pointer;background:transparent;border-radius:4px;flex-shrink:0;padding:4px 8px}
@media (max-width:640px){.${terminalClass.list}{padding-left:6px;padding-right:6px}.${terminalClass.listActions}{margin-left:2px;padding-left:2px}.${terminalClass.toolsPanel}{padding-left:6px;padding-right:6px}}
`
