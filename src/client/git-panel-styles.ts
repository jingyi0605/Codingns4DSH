const STYLE_ID = 'codingns4dsh-git-panel'

/**
 * Git 面板的交互态类名。
 *
 * 内联样式无法表达 `:hover`、`:active`、`:focus-visible` 和 `:disabled`，而且内联的
 * `background`/`border`/`color` 会盖掉样式表，所以这里把「视觉表面」交给类名，
 * 内联样式只负责尺寸与排版。取值全部来自 DSH 真实令牌，与内置组件同一套观感。
 */
export const gitPanelClass = {
  action: 'codingns4dsh-git-action',
  actionDanger: 'codingns4dsh-git-action-danger',
  button: 'codingns4dsh-git-button',
  buttonPrimary: 'codingns4dsh-git-button-primary',
  row: 'codingns4dsh-git-row',
  menuTrigger: 'codingns4dsh-git-menu-trigger',
  menu: 'codingns4dsh-git-menu',
  menuItem: 'codingns4dsh-git-menu-item',
  menuItemDanger: 'codingns4dsh-git-menu-item-danger',
  progress: 'codingns4dsh-git-progress',
  field: 'codingns4dsh-git-field',
  select: 'codingns4dsh-git-select',
  ref: 'codingns4dsh-git-ref',
  segmented: 'codingns4dsh-git-segmented',
  segmentedIndicator: 'codingns4dsh-git-segmented-indicator',
  segment: 'codingns4dsh-git-segment',
} as const

/** 安装 Git 面板的交互态样式，重复调用只保留一份。非浏览器环境（单元测试）直接跳过。 */
export function installGitPanelStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_ID}"]`)
  if (existing !== null) return () => undefined
  const style = document.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = gitPanelCss
  document.head.appendChild(style)
  return () => style.remove()
}

const focusRing = 'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px'
const focusRingInset = 'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:-2px'
const hover = 'background:var(--dsw-alias-interactive-bg-hover)'
const active = 'background:var(--dsw-alias-interactive-bg-active)'
const disabled = 'opacity:.4;cursor:not-allowed'

const gitPanelCss = `
.${gitPanelClass.action}{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;padding:0;border:0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font-size:16px;line-height:1}
.${gitPanelClass.action}:hover:not(:disabled){${hover};color:var(--dsw-alias-label-primary)}
.${gitPanelClass.action}:active:not(:disabled){${active}}
.${gitPanelClass.action}:focus-visible{${focusRing}}
.${gitPanelClass.action}:disabled{${disabled}}
.${gitPanelClass.actionDanger}{color:var(--dsw-alias-state-error-primary)}
.${gitPanelClass.actionDanger}:hover:not(:disabled){${hover};color:var(--dsw-alias-state-error-primary)}
.${gitPanelClass.button}{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);cursor:pointer}
.${gitPanelClass.button}:hover:not(:disabled){${hover}}
.${gitPanelClass.button}:active:not(:disabled){${active}}
.${gitPanelClass.button}:focus-visible{${focusRing}}
.${gitPanelClass.button}:disabled{${disabled}}
.${gitPanelClass.buttonPrimary}{border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);font-weight:600}
.${gitPanelClass.buttonPrimary}:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.${gitPanelClass.buttonPrimary}:active:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.${gitPanelClass.row}{border-radius:var(--dsw-radius-xs);transition:background 120ms ease}
.${gitPanelClass.row}:hover{${hover}}
.${gitPanelClass.menuTrigger}{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;padding:0;border:0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer;font-size:16px;line-height:1}
.${gitPanelClass.menuTrigger}:hover:not(:disabled){${hover};color:var(--dsw-alias-label-primary)}
.${gitPanelClass.menuTrigger}:active:not(:disabled){${active}}
.${gitPanelClass.menuTrigger}:focus-visible{${focusRing}}
.${gitPanelClass.menuTrigger}:disabled{${disabled}}
.${gitPanelClass.menu}{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3);box-shadow:var(--dsw-elevation-prominent)}
.${gitPanelClass.menuItem}{display:block;width:100%;box-sizing:border-box;border:0;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-primary);background:transparent;text-align:left;cursor:pointer;font-size:13px;line-height:20px;white-space:nowrap}
.${gitPanelClass.menuItem}:hover:not(:disabled){${hover}}
.${gitPanelClass.menuItem}:active:not(:disabled){${active}}
.${gitPanelClass.menuItem}:focus-visible{${focusRingInset}}
.${gitPanelClass.menuItem}:disabled{${disabled}}
.${gitPanelClass.menuItemDanger}{color:var(--dsw-alias-state-error-primary)}
.${gitPanelClass.progress}{display:inline-block;animation:codingns4dsh-git-spin 900ms linear infinite}
.${gitPanelClass.field}{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary)}
.${gitPanelClass.field}:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
.${gitPanelClass.field}:focus-visible{${focusRing}}
.${gitPanelClass.field}:disabled{${disabled}}
.${gitPanelClass.select}{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-secondary);cursor:pointer}
.${gitPanelClass.select}:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
.${gitPanelClass.select}:focus-visible{${focusRing}}
.${gitPanelClass.select}:disabled{${disabled}}
.${gitPanelClass.ref}{display:inline-flex;align-items:center;gap:4px;border-radius:999px;white-space:nowrap}
.${gitPanelClass.segmented}{position:relative;display:inline-grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover)}
.${gitPanelClass.segmentedIndicator}{position:absolute;top:4px;left:4px;width:calc((100% - 8px - 2px * (var(--dsh-segment-count) - 1)) / var(--dsh-segment-count));height:calc(100% - 8px);border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft);transform:translateX(calc(var(--dsh-segment-index) * (100% + 2px)));transition:transform 160ms ease;pointer-events:none}
.${gitPanelClass.segment}{box-sizing:border-box;position:relative;z-index:1;height:28px;padding:0 16px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;cursor:pointer;transition:color 120ms ease}
.${gitPanelClass.segment}:hover:not(:disabled),.${gitPanelClass.segment}[aria-selected='true']{color:var(--dsw-alias-label-primary)}
.${gitPanelClass.segment}:disabled{cursor:default;opacity:.4}
.${gitPanelClass.segment}:focus-visible{${focusRingInset}}
@keyframes codingns4dsh-git-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.${gitPanelClass.row}{transition:none}.${gitPanelClass.segmentedIndicator},.${gitPanelClass.segment}{transition:none}.${gitPanelClass.progress}{animation:none}}
`
