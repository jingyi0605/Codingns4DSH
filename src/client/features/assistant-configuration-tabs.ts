import { createElement, useId } from 'react'
import type { KeyboardEvent, ReactElement, ReactNode } from 'react'
import type { CodingNsTranslator } from '../locale.js'
import { dshThemeColor } from '../theme.js'

const tabs = [
  { id: 'basic', label: 'awb.tab.basic' }, { id: 'appearance', label: 'awb.tab.appearance' },
  { id: 'voice', label: 'awb.tab.voice' }, { id: 'more', label: 'awb.more' },
] as const
export type AssistantConfigurationTab = typeof tabs[number]['id']

/** 延迟挂载尚未访问的页，访问后保留实例，避免切换丢失资源表单或中断安装。 */
export function AssistantConfigurationTabs({ active, visited, panels, preview, t, onChange }: {
  readonly active: AssistantConfigurationTab
  readonly visited: readonly AssistantConfigurationTab[]
  readonly panels: Readonly<Record<AssistantConfigurationTab, ReactNode>>
  readonly preview: ReactNode
  readonly t: CodingNsTranslator
  readonly onChange: (tab: AssistantConfigurationTab) => void
}): ReactElement {
  const id = useId()
  return createElement('div', { 'data-codingns-configuration-tabs': true, style: { display: 'grid', gap: 11, minWidth: 0 } },
    createElement(AssistantConfigurationTabBar, { id, active, t, onChange }),
    createElement('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 22, minWidth: 0 } },
      createElement('div', { style: { flex: '1 1 330px', minWidth: 0 } },
        ...tabs.map((tab) => createElement('section', {
          key: tab.id, id: `${id}-panel-${tab.id}`, role: 'tabpanel', 'aria-labelledby': `${id}-tab-${tab.id}`,
          hidden: tab.id !== active, tabIndex: 0, 'data-codingns-configuration-page': tab.id,
          style: { display: tab.id === active ? 'grid' : 'none', gap: 11, minWidth: 0 },
        }, tab.id === active || visited.includes(tab.id) ? panels[tab.id] : null))),
      // 更多设置使用全宽；预览实例保留，来回切换不重新加载所选形象。
      createElement('div', { hidden: active === 'more', 'data-codingns-configuration-preview': true,
        style: { display: active === 'more' ? 'none' : 'flex', flex: '1 1 290px', minWidth: 0 } }, preview)))
}

/** 标签可用方向键、Home 和 End 切换，只有当前标签进入顺序焦点。 */
export function AssistantConfigurationTabBar({ id, active, t, onChange }: {
  readonly id: string; readonly active: AssistantConfigurationTab; readonly t: CodingNsTranslator
  readonly onChange: (tab: AssistantConfigurationTab) => void
}): ReactElement {
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    onChange(tabs[next]!.id)
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }
  return createElement('div', { role: 'tablist', 'aria-label': t('awb.configure'),
    style: { position: 'sticky', top: 0, zIndex: 2, display: 'flex', gap: 4, padding: 4, borderRadius: 12,
      background: dshThemeColor.cardBackground, border: `1px solid ${dshThemeColor.border}`, overflowX: 'auto', minWidth: 0 } },
    ...tabs.map((tab, index) => createElement('button', { key: tab.id, type: 'button', role: 'tab', id: `${id}-tab-${tab.id}`,
      'aria-controls': `${id}-panel-${tab.id}`, 'aria-selected': active === tab.id, tabIndex: active === tab.id ? 0 : -1,
      onClick: () => onChange(tab.id), onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => navigate(event, index),
      style: { flex: '1 0 auto', minHeight: 36, border: 0, borderRadius: 8, padding: '7px 12px', whiteSpace: 'nowrap', cursor: 'pointer',
        font: 'inherit', fontSize: 13, fontWeight: active === tab.id ? 600 : 400,
        color: active === tab.id ? dshThemeColor.labelPrimary : dshThemeColor.labelSecondary,
        background: active === tab.id ? dshThemeColor.pageBackground : 'transparent',
        boxShadow: active === tab.id ? dshThemeColor.subtleShadow : 'none' },
    }, t(tab.label))))
}
