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
  list: 'codingns4dsh-terminal-list',
  newButton: 'codingns4dsh-terminal-new-button',
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
.${terminalClass.list}{box-sizing:border-box;width:100%;height:40px;min-width:0;min-height:40px;display:flex;align-items:center;gap:2px;padding:3px 8px;background:var(--dsw-alias-bg-layer-1);border-bottom:.5px solid var(--dsw-alias-border-l3);overflow-x:auto;overflow-y:hidden;flex:none}
.${terminalClass.newButton}{box-sizing:border-box;flex:none;align-self:center;height:30px;min-height:30px;max-height:30px;margin:0 0 0 4px;padding:0 10px;white-space:nowrap}
.${terminalClass.listRow}{box-sizing:border-box;display:flex;align-items:center;height:32px;min-width:110px;max-width:220px;border-radius:var(--dsw-radius-sm,6px);background:transparent;flex:none}
.${terminalClass.listRowSelected}{background:var(--dsw-alias-interactive-bg-hover);box-shadow:var(--dsw-elevation-soft,0 1px 2px rgba(0,0,0,.08))}
.${terminalClass.listSelect}{box-sizing:border-box;min-width:0;height:32px;min-height:32px;flex:1;text-align:left;color:inherit;border:0;background:transparent;cursor:pointer;padding:0 8px;display:flex;align-items:center;gap:5px;font:inherit;line-height:20px}
.${terminalClass.listSelect} span{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}
.${terminalClass.listSelect} small{color:var(--dsw-alias-label-caption);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${terminalClass.listInput}{box-sizing:border-box;min-width:0;height:28px;min-height:28px;flex:1;margin:0 4px;color:inherit;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,6px);padding:0 6px;font:inherit;line-height:20px}
.${terminalClass.listClose}{box-sizing:border-box;width:28px;height:32px;min-height:32px;padding:0;border:0;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font:inherit;font-size:16px;line-height:20px;flex:none}
.${terminalClass.listClose}:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.${terminalClass.content}{box-sizing:border-box;width:100%;min-width:0;min-height:0;display:flex;flex:1 1 auto;overflow:hidden}
.${terminalClass.empty}{display:flex;flex:1;min-height:0;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--dsw-alias-label-secondary);text-align:center;padding:24px}
.${terminalClass.screen}{box-sizing:border-box;width:100%;min-width:0;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);flex:1 1 auto;padding:8px;overflow:hidden}
.${terminalClass.status}{background:var(--dsw-alias-bg-l2);flex-wrap:wrap;align-items:center;gap:8px;padding:5px 12px;display:flex}
.${terminalClass.error}{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-l2);margin:0;padding:10px 12px}
.${terminalClass.cleanupStack}{pointer-events:auto;gap:8px;max-width:min(440px,calc(100vw - 40px));display:grid;position:fixed;bottom:20px;right:20px}
.${terminalClass.cleanupNotice}{border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-l1);overflow-wrap:anywhere;border-radius:8px;align-items:center;gap:12px;padding:12px 16px;font-size:13px;display:flex;box-shadow:0 4px 20px #0002}
.${terminalClass.cleanupNotice} button{border:.5px solid var(--dsw-alias-border-l3);color:inherit;cursor:pointer;background:transparent;border-radius:4px;flex-shrink:0;padding:4px 8px}
`
