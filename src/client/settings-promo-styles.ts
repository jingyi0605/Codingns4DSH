/**
 * 设置页顶部推广条的样式与交互态。
 *
 * 内联样式无法表达 `:hover`、`:focus-visible` 和窄屏断点，而推广条恰恰靠悬停
 * 反馈促进用户点击 GitHub 按钮，所以表面样式全部落在注入的样式表里。取值只用
 * DSH 真实存在的令牌（对照 `@deepseek-ai/dsh-client-ui-theme` 的 403 个
 * `--dsw-*`），保证明暗主题下都能跟随宿主。
 */

const STYLE_ID = 'codingns4dsh-settings-promo'

/** 推广条的元素类名；结构由组件决定，视觉由本模块的样式表决定。 */
export const settingsPromoClass = {
  root: 'codingns4dsh-settings-promo',
  brand: 'codingns4dsh-settings-promo-brand',
  headline: 'codingns4dsh-settings-promo-headline',
  logo: 'codingns4dsh-settings-promo-logo',
  title: 'codingns4dsh-settings-promo-title',
  version: 'codingns4dsh-settings-promo-version',
  text: 'codingns4dsh-settings-promo-text',
  hand: 'codingns4dsh-settings-promo-hand',
  action: 'codingns4dsh-settings-promo-action',
} as const

/**
 * 安装推广条样式，重复调用只保留一份。
 *
 * 返回移除函数；非浏览器环境（Node 单测直接导入组件）没有 `document`，此时
 * 返回空操作，让组件仍可被静态检查而不依赖 DOM。
 */
export function installSettingsPromoStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${STYLE_ID}"]`)
  if (existing !== null) return () => undefined
  const style = document.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = STYLE_ID
  style.textContent = settingsPromoCss
  document.head.appendChild(style)
  return () => style.remove()
}

const focusRing = 'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px'

const settingsPromoCss = `
.${settingsPromoClass.root}{box-sizing:border-box;display:flex;align-items:center;gap:12px;width:100%;padding:10px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-soft)}
.${settingsPromoClass.brand}{display:flex;flex-direction:column;gap:6px;flex:0 0 auto;min-width:0}
.${settingsPromoClass.headline}{display:flex;align-items:center;gap:8px;min-width:0}
.${settingsPromoClass.logo}{flex:0 0 auto;color:var(--dsw-alias-button-info-fill)}
.${settingsPromoClass.title}{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;line-height:1.25;font-weight:650;white-space:nowrap}
.${settingsPromoClass.version}{align-self:flex-start;box-sizing:border-box;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-secondary);background:var(--dsw-specific-input-major);font-size:11px;line-height:16px;white-space:nowrap}
.${settingsPromoClass.text}{flex:1 1 auto;min-width:0;margin:0;color:var(--dsw-alias-button-info-fill);font-size:12px;line-height:1.5;text-align:right}
.${settingsPromoClass.hand}{margin-left:4px}
.${settingsPromoClass.action}{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:0 0 auto;min-height:28px;padding:4px 12px;border:.5px solid var(--dsw-alias-button-info-fill);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-button-info-fill);background:color-mix(in srgb,var(--dsw-alias-button-info-fill) 10%,transparent);font-size:12px;line-height:1.3;font-weight:600;text-decoration:none;cursor:pointer;transition:background 160ms ease,color 160ms ease,border-color 160ms ease}
.${settingsPromoClass.action}:hover{background:var(--dsw-alias-button-info-hover);border-color:var(--dsw-alias-button-info-hover);color:var(--dsw-alias-label-primary-foreground)}
.${settingsPromoClass.action}:active{background:var(--dsw-alias-button-info-fill);border-color:var(--dsw-alias-button-info-fill);color:var(--dsw-alias-label-primary-foreground)}
.${settingsPromoClass.action}:focus-visible{${focusRing}}
@media (max-width:640px){.${settingsPromoClass.root}{flex-direction:column;align-items:center;gap:10px;padding:12px}.${settingsPromoClass.brand}{align-items:center}.${settingsPromoClass.version}{align-self:center}}
@media (prefers-reduced-motion:reduce){.${settingsPromoClass.action}{transition:none}}
`
