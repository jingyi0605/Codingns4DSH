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
  surfaceSubtle: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.06))',
  buttonBackground: 'var(--dsw-alias-button-elevated-fill, transparent)',
  // 0.1.7 的 specific-menu 可能带透明度；layer-3 在 0.1.5 至 0.1.7 中均为弹层实底。
  menuBackground: 'var(--dsw-alias-bg-layer-3, var(--dsw-specific-menu, Canvas))',
  // 侧栏面板内嵌卡片比弹层低一层，暗色下只比侧栏表面亮一档，避免形成刺眼的色块。
  cardBackground: 'var(--dsw-alias-bg-layer-1, Canvas)',
  pageBackground: 'var(--dsw-alias-bg-base, Canvas)',
  overlay: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.45))',
  accent: 'var(--dsw-alias-button-info-fill, #1677ff)',
  // 主操作按钮沿用 DSH 品牌填充：暗色下是浅底深字，和内置主按钮完全一致。
  primaryBackground: 'var(--dsw-alias-button-primary-fill, #1677ff)',
  primaryHoverBackground: 'var(--dsw-alias-button-primary-hover, #4096ff)',
  primaryForeground: 'var(--dsw-alias-label-primary-foreground, #fff)',
  success: 'var(--dsw-alias-state-success-primary, #16803c)',
  error: 'var(--dsw-alias-state-error-primary, #b42318)',
  // 状态描边用 l3/l4：DSH 的输入控件是 0.5px，比 l2 更轻。
  fieldBorder: 'var(--dsw-alias-border-l4, #d9d9d9)',
  menuBorder: 'var(--dsw-alias-border-l3, #d9d9d9)',
  switchThumb: 'var(--dsw-static-neutral-00, #fff)',
  prominentShadow: 'var(--dsw-elevation-prominent, 0 12px 40px rgba(0, 0, 0, 0.25))',
  subtleShadow: 'var(--dsw-elevation-soft, 0 1px 2px rgba(0, 0, 0, 0.06))',
  // 交互态令牌：内联样式无法表达 :hover/:active/:focus-visible，交给注入的插件样式表。
  hoverBackground: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08))',
  activeBackground: 'var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.14))',
  focusRing: 'var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))',
  // Diff 行背景直接复用 DSH DiffBlock 的同一组令牌，保证与内置 Diff 视图一致。
  diffAddedBackground: 'var(--dsw-alias-code-diff-added, rgba(34, 197, 94, 0.13))',
  diffDeletedBackground: 'var(--dsw-alias-code-diff-deleted, rgba(239, 68, 68, 0.13))',
  codeFont: 'var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)',
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

/** Codingns4DSH 设置页共享外壳：占满宿主内容区，避免重复留白。 */
export const dshSettingsPageStyle: CSSProperties = {
  ...dshFormRootStyle,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  width: '100%',
  maxWidth: 'none',
  margin: 0,
  padding: 0,
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
  gap: 12,
  minHeight: 58,
  padding: '12px 14px',
  boxSizing: 'border-box',
  cursor: 'pointer',
  listStyle: 'none',
}

export const dshSettingsSummaryTextStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  flex: '1 1 auto',
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

/** 终端外观设置的紧凑双列布局。 */
export const dshSettingsGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 12,
}

export const dshSettingsSectionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  paddingBottom: 2,
}

/** 设置写入结果的顶部浮动提示。 */
export const dshSettingsToastStyle: CSSProperties = {
  position: 'sticky',
  top: 8,
  zIndex: 20,
  alignSelf: 'center',
  width: 'min(300px, calc(100% - 24px))',
  padding: '9px 14px',
  border: `1px solid ${dshThemeColor.border}`,
  borderRadius: 8,
  background: dshThemeColor.menuBackground,
  boxShadow: dshThemeColor.prominentShadow,
  color: dshThemeColor.labelPrimary,
  fontSize: 13,
  lineHeight: 1.4,
  textAlign: 'center',
}

/** 模态框和弹出菜单必须成对设置前景色与背景色。 */
export const dshPopupSurfaceStyle: CSSProperties = {
  color: dshThemeColor.labelPrimary,
  background: dshThemeColor.menuBackground,
  boxShadow: dshThemeColor.prominentShadow,
}
