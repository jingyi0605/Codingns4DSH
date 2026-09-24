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
  surfaceSubtle: 'var(--dsw-alias-bg-secondary, rgba(127, 127, 127, 0.06))',
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

/** CodingNS 设置页共享外壳：保持紧凑宽度，避免挤压宿主设置导航。 */
export const dshSettingsPageStyle: CSSProperties = {
  ...dshFormRootStyle,
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
  width: '100%',
  maxWidth: 900,
  margin: '0 auto',
  padding: '20px clamp(16px, 3vw, 32px) 28px',
  boxSizing: 'border-box',
}

/** 设置页标题区，使用宿主主题颜色而不是独立品牌色。 */
export const dshSettingsHeaderStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  paddingBottom: 16,
  borderBottom: `1px solid ${dshThemeColor.border}`,
}

export const dshSettingsTitleStyle: CSSProperties = {
  margin: 0,
  color: dshThemeColor.labelPrimary,
  fontSize: 21,
  lineHeight: 1.3,
  fontWeight: 700,
}

export const dshSettingsSubtitleStyle: CSSProperties = {
  margin: 0,
  color: dshThemeColor.labelSecondary,
  fontSize: 13,
  lineHeight: 1.5,
}

/** 模块卡片和标题栏共享的结构样式。 */
export const dshSettingsCardStyle: CSSProperties = {
  background: dshThemeColor.pageBackground,
  border: `1px solid ${dshThemeColor.border}`,
  borderRadius: 8,
  overflow: 'hidden',
  boxShadow: dshThemeColor.subtleShadow,
}

export const dshSettingsSummaryStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 14,
  minHeight: 58,
  padding: '12px 16px',
  boxSizing: 'border-box',
  cursor: 'pointer',
  listStyle: 'none',
}

export const dshSettingsSummaryTextStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  minWidth: 0,
}

export const dshSettingsSummaryLabelStyle: CSSProperties = {
  color: dshThemeColor.labelPrimary,
  fontSize: 14,
  lineHeight: 1.35,
  fontWeight: 650,
}

export const dshSettingsSummaryDescriptionStyle: CSSProperties = {
  color: dshThemeColor.labelSecondary,
  fontSize: 12,
  lineHeight: 1.45,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

export const dshSettingsBodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: '18px 20px 20px',
  borderTop: `1px solid ${dshThemeColor.border}`,
  boxSizing: 'border-box',
}

export const dshSettingsFieldLabelStyle: CSSProperties = {
  color: dshThemeColor.labelSecondary,
  fontSize: 12,
  lineHeight: 1.4,
  fontWeight: 600,
}

export const dshSettingsFieldStyle: CSSProperties = {
  ...dshFieldStyle,
  width: '100%',
  minHeight: 36,
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 6,
  fontSize: 13,
}

export const dshSettingsButtonStyle: CSSProperties = {
  ...dshButtonStyle,
  minHeight: 36,
  padding: '8px 14px',
  borderRadius: 6,
  fontSize: 13,
  lineHeight: 1.3,
  cursor: 'pointer',
}

export const dshSettingsPrimaryButtonStyle: CSSProperties = {
  ...dshSettingsButtonStyle,
  color: dshThemeColor.switchThumb,
  background: dshThemeColor.accent,
  borderColor: dshThemeColor.accent,
}

export const dshSettingsRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
}

export const dshSettingsListRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  minHeight: 52,
  padding: '10px 0',
  borderBottom: `1px solid ${dshThemeColor.border}`,
  boxSizing: 'border-box',
}

export const dshSettingsHelpStyle: CSSProperties = {
  color: dshThemeColor.labelTertiary,
  fontSize: 12,
  lineHeight: 1.5,
}

export const dshSettingsNoteStyle: CSSProperties = {
  padding: '10px 12px',
  border: `1px solid ${dshThemeColor.border}`,
  borderRadius: 6,
  color: dshThemeColor.labelSecondary,
  background: dshThemeColor.surfaceSubtle,
  fontSize: 12,
  lineHeight: 1.5,
}

/** 模态框和弹出菜单必须成对设置前景色与背景色。 */
export const dshPopupSurfaceStyle: CSSProperties = {
  color: dshThemeColor.labelPrimary,
  background: dshThemeColor.menuBackground,
  boxShadow: dshThemeColor.prominentShadow,
}
