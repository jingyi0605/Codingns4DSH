import type { CSSProperties } from 'react'

/** 助理各页共用选项排版，避免开关、许可复选框和字段标签分别继承宿主字号。 */
export const assistantSettingTextStyle: CSSProperties = { fontSize: 13, fontWeight: 400, lineHeight: 1.5 }
export const assistantSettingFieldStyle: CSSProperties = { ...assistantSettingTextStyle, display: 'grid', gap: 6, minWidth: 0 }
export const assistantSettingCheckboxStyle: CSSProperties = { ...assistantSettingTextStyle, display: 'flex', alignItems: 'start', gap: 8 }
export const assistantSettingSwitchStyle: CSSProperties = { ...assistantSettingTextStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }
