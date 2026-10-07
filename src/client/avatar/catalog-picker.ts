import { createElement, useEffect, useId, useState } from 'react'
import type { ReactElement } from 'react'
import { DshMenu, resolveChevronDownIcon } from '../../dsh-capabilities/client/primitives-adapter.js'
import { builtinAssistantAvatarLabelKey, listAssistantAvatars } from '../../shared/assistant-avatar.js'
import type { AssistantAppearanceSettings } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarCatalogEntry } from '../../shared/assistant-avatar-catalog.js'
import { getAssistantAvatarPreset } from '../../shared/assistant-avatar-presets.js'
import type { CodingNsTranslator } from '../locale.js'
import { dshSettingsFieldStyle } from '../theme.js'
import { assistantSettingFieldStyle } from '../assistant-settings-styles.js'

export interface AssistantAvatarChoice {
  readonly id: string
  readonly label: string
  /** 来源单独保存，名称不再拼接标记，避免用户命名影响标签显示。 */
  readonly thirdParty: boolean
  readonly disabled?: boolean
  /** 仅未登记条目携带目录信息，选择后预览；已登记角色直接切换。 */
  readonly catalog?: AssistantAvatarCatalogEntry
}

/** 合并展示选项，沿用安装后的模型 ID 去重，不把目录元数据写进设置清单。 */
export function assistantAvatarChoices(appearance: AssistantAppearanceSettings, entries: readonly AssistantAvatarCatalogEntry[], t: CodingNsTranslator, includeLegacy = true): readonly AssistantAvatarChoice[] {
  const choices = new Map<string, AssistantAvatarChoice>()
  for (const model of listAssistantAvatars(appearance, includeLegacy)) {
    const builtinLabel = builtinAssistantAvatarLabelKey(model.id)
    const labelKey = builtinLabel ?? (appearance.models.some((registered) => registered.id === model.id) ? undefined : getAssistantAvatarPreset(model.id)?.labelKey)
    const name = labelKey === undefined ? model.name : t(labelKey)
    choices.set(model.id, { id: model.id, label: name, thirdParty: builtinLabel === undefined })
  }
  for (const entry of entries) {
    const id = `catalog-${entry.id}`
    if (!choices.has(id)) choices.set(id, { id, label: entry.name, thirdParty: true, catalog: entry })
  }
  return [...choices.values()]
}

interface AssistantAvatarPickerProps {
  readonly choices: readonly AssistantAvatarChoice[]; readonly value: string; readonly disabled: boolean
  readonly t: CodingNsTranslator; readonly onChoose: (choice: AssistantAvatarChoice) => void
  readonly label?: string
}

/** 内置形象只有名称，第三方形象在名称旁显示独立彩色标签。 */
export function AssistantAvatarChoiceLabel({ choice, t }: { readonly choice: AssistantAvatarChoice; readonly t: CodingNsTranslator }): ReactElement {
  return createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
    createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, choice.label),
    !choice.thirdParty ? null : createElement('span', { 'data-codingns-avatar-third-party-badge': true,
      // 固定高对比蓝底白字，明暗主题中均可读；标签不随长名称收缩。
      style: { flexShrink: 0, padding: '1px 6px', borderRadius: 4, background: '#2563eb', color: '#fff', fontSize: 11, fontWeight: 500, lineHeight: '18px', whiteSpace: 'nowrap' } }, t('avatar.thirdPartyBadge')))
}

/** 一个选择入口同时服务内置、已安装和待安装形象。 */
export function AssistantAvatarPicker(props: AssistantAvatarPickerProps): ReactElement {
  const [open, setOpen] = useState(false)
  const id = useId()
  useEffect(() => { if (props.disabled) setOpen(false) }, [props.disabled])
  return createElement(AssistantAvatarPickerView, { ...props, id, open, onOpenChange: setOpen })
}

/** 展开状态与展示分离；菜单行为由 DSH 原语负责，业务只处理有效选择。 */
export function AssistantAvatarPickerView({ choices, value, disabled, t, onChoose, label = t('avatar.selected'), id, open, onOpenChange }: AssistantAvatarPickerProps & {
  readonly id: string; readonly open: boolean; readonly onOpenChange: (open: boolean) => void
}): ReactElement {
  const selected = choices.find((choice) => choice.id === value)
  const expanded = open && !disabled
  const name = selected === undefined ? value : selected.thirdParty ? t('avatar.externalName', { name: selected.label }) : selected.label
  const anchor = createElement('button', { id, type: 'button', disabled, 'aria-label': `${label}: ${name}`, 'aria-haspopup': 'menu', 'aria-expanded': expanded,
    'data-codingns-avatar-list': true, 'data-codingns-avatar-selected': value,
    style: { ...dshSettingsFieldStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, textAlign: 'left', cursor: disabled ? 'default' : 'pointer' },
    onClick: () => { if (!disabled) onOpenChange(!expanded) },
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (disabled || expanded || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
      event.preventDefault(); onOpenChange(true)
    } },
    selected === undefined ? name : createElement(AssistantAvatarChoiceLabel, { choice: selected, t }),
    createElement('span', { 'aria-hidden': true, style: { display: 'flex', flexShrink: 0 } }, createElement(resolveChevronDownIcon(), { size: 14 })))
  return createElement('label', { htmlFor: id, style: assistantSettingFieldStyle }, createElement('span', null, label),
    // 弹层高于助理对话框，窄屏限制在视口内；原语负责菜单滚动与边缘定位。
    createElement('style', null, '.codingns4dsh-avatar-picker{width:100%;min-width:0}.codingns4dsh-avatar-menu{z-index:10002;width:min(360px,calc(100vw - 24px));max-width:calc(100vw - 24px)}'),
    createElement(DshMenu, { open: expanded, anchor, portal: true, autoFocus: true, className: 'codingns4dsh-avatar-picker', listClassName: 'codingns4dsh-avatar-menu',
      selectedId: value, items: choices.map((choice) => ({ id: choice.id, label: createElement(AssistantAvatarChoiceLabel, { choice, t }), disabled: disabled || choice.disabled === true })),
      onClose: () => onOpenChange(false), onSelect: (choiceId: string) => {
        const choice = choices.find((item) => item.id === choiceId)
        if (disabled || choice === undefined || choice.disabled) return
        onOpenChange(false); onChoose(choice)
      } }))
}
