import type { CSSProperties } from 'react'

/**
 * DSH 0.1.6 暴露的主题令牌。
 *
 * 回退值只服务于独立测试或宿主尚未加载主题的瞬间；正常运行时由 DSH 的明暗
 * 主题覆盖。所有表单表面必须同时设置背景和前景，避免再次出现白底白字。
 */
export const dshThemeColor = {
  labelPrimary: 'var(--dsw-alias-label-primary, CanvasText)',
  labelSecondary: 'var(--dsw-alias-label-secondary, GrayText)',
  labelTertiary: 'var(--dsw-alias-label-tertiary, GrayText)',
  labelCaption: 'var(--dsw-alias-label-caption, GrayText)',
  border: 'var(--dsw-alias-border-l2, #d9d9d9)',
  inputBackground: 'var(--dsw-specific-input-major, Canvas)',
  buttonBackground: 'var(--dsw-alias-button-elevated-fill, transparent)',
  menuBackground: 'var(--dsw-specific-menu, Canvas)',
  pageBackground: 'var(--dsw-alias-bg-primary, Canvas)',
  overlay: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45))',
  accent: 'var(--dsw-alias-button-info-fill, #1677ff)',
  success: 'var(--dsw-alias-state-success-primary, #16803c)',
  error: 'var(--dsw-alias-state-error-primary, #b42318)',
  switchThumb: 'var(--dsw-static-neutral-00, #fff)',
  prominentShadow: 'var(--dsw-elevation-prominent, 0 12px 40px rgba(0, 0, 0, 0.25))',
  subtleShadow: 'var(--dsw-elevation-l1, 0 1px 2px rgba(0, 0, 0, 0.06))',
} as const

/** 设置模块根节点显式接入 DSH 的主文字色。 */
export const dshFormRootStyle: CSSProperties = {
  color: dshThemeColor.labelPrimary,
}

/** input、select 和 textarea 共用的主题表面。 */
export const dshFieldStyle: CSSProperties = {
  color: dshThemeColor.labelPrimary,
  background: dshThemeColor.inputBackground,
  border: `1px solid ${dshThemeColor.border}`,
}

/** 普通表单按钮共用的主题表面。 */
export const dshButtonStyle: CSSProperties = {
  color: dshThemeColor.labelPrimary,
  background: dshThemeColor.buttonBackground,
  border: `1px solid ${dshThemeColor.border}`,
}

/** 模态框和弹出菜单必须成对设置前景色与背景色。 */
export const dshPopupSurfaceStyle: CSSProperties = {
  color: dshThemeColor.labelPrimary,
  background: dshThemeColor.menuBackground,
  boxShadow: dshThemeColor.prominentShadow,
}
