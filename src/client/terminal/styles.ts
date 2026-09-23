const STYLE_ID = 'dsh-codingns-terminal-ui'

export const terminalClass = {
  guideEntry: 'dsh-codingns-terminal-guide-entry',
  guideMain: 'dsh-codingns-terminal-guide-main',
  guideIcon: 'dsh-codingns-terminal-guide-icon',
  guideText: 'dsh-codingns-terminal-guide-text',
  guideTitle: 'dsh-codingns-terminal-guide-title',
  guideDescription: 'dsh-codingns-terminal-guide-description',
  guideTrigger: 'dsh-codingns-terminal-guide-trigger',
  guideMenu: 'dsh-codingns-terminal-guide-menu',
  title: 'dsh-codingns-terminal-title',
  titleInput: 'dsh-codingns-terminal-title-input',
  root: 'dsh-codingns-terminal-root',
  screen: 'dsh-codingns-terminal-screen',
  status: 'dsh-codingns-terminal-status',
  error: 'dsh-codingns-terminal-error',
  cleanupStack: 'dsh-codingns-terminal-cleanup-stack',
  cleanupNotice: 'dsh-codingns-terminal-cleanup-notice',
} as const

/** 安装与 DSH 0.1.6 内置终端相同的布局和主题令牌。 */
export function installTerminalStyles(): () => void {
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_ID}"]`)
  if (existing !== null) return () => undefined
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-codingns'
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
.${terminalClass.title}{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.${terminalClass.titleInput}{width:120px;min-width:48px;max-width:100%;color:inherit;font:inherit;background:var(--dsw-alias-bg-l1);border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;outline:none;padding:0 4px}
.${terminalClass.root}{box-sizing:border-box;height:100%;min-height:0;color:var(--dsw-alias-label-primary);flex-direction:column;flex:1;padding-top:8px;font-size:13px;display:flex}
.${terminalClass.screen}{min-width:0;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);flex:1;padding:8px;overflow:hidden}
.${terminalClass.status}{background:var(--dsw-alias-bg-l2);flex-wrap:wrap;align-items:center;gap:8px;padding:5px 12px;display:flex}
.${terminalClass.error}{overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-l2);margin:0;padding:10px 12px}
.${terminalClass.cleanupStack}{pointer-events:auto;gap:8px;max-width:min(440px,calc(100vw - 40px));display:grid;position:fixed;bottom:20px;right:20px}
.${terminalClass.cleanupNotice}{border:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-l1);overflow-wrap:anywhere;border-radius:8px;align-items:center;gap:12px;padding:12px 16px;font-size:13px;display:flex;box-shadow:0 4px 20px #0002}
.${terminalClass.cleanupNotice} button{border:.5px solid var(--dsw-alias-border-l3);color:inherit;cursor:pointer;background:transparent;border-radius:4px;flex-shrink:0;padding:4px 8px}
`
