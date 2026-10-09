import { createElement, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { AssistantChatCatalog } from '../../shared/contracts/assistant.js'
import { ASSISTANT_PERSONALITY_MAX_CHARS } from '../../shared/assistant-lifecycle.js'
import { listAssistantAvatars, normalizeAssistantAppearance } from '../../shared/assistant-avatar.js'
import type { AssistantTtsSnapshot } from '../../shared/assistant-tts.js'
import { readAssistantPrompts } from '../../shared/assistant-prompts.js'
import type { CodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsFieldStyle, dshSettingsHelpStyle, dshThemeColor } from '../theme.js'
import { AssistantAvatarPortraitEditor } from '../avatar/portrait-editor.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import { AssistantAppearanceEditor } from '../avatar/settings-panel.js'
import { AssistantAvatarPicker, assistantAvatarChoices } from '../avatar/catalog-picker.js'
import { getAssistantAvatarManager } from '../avatar/manager.js'
import { AssistantAvatarEngineDialog, AssistantAvatarEngineProgress, useAssistantAvatarEngine } from '../avatar/engine.js'
import type { AssistantAvatarPreviewTargetProps } from '../avatar/catalog-panel.js'
import { AssistantVoiceSettings } from './assistant-voice-settings.js'
import { AssistantVoiceInitializationPanel } from './assistant-voice-initialization.js'
import { VoiceModelManagerPanel } from './voice-initialization-dialog.js'
import { AssistantPromptEditor } from './assistant-prompt-editor.js'
import { getGlobalVoiceAdapter } from '../global-voice-runtime-registry.js'
import type { AssistantConfigurationTab } from './assistant-configuration-tabs.js'
import { assistantSettingFieldStyle } from '../assistant-settings-styles.js'
import type { CodingNsClientServices } from './types.js'
import type { AssistantDraft } from './assistant-workbench.js'

import type { AssistantSettings } from '../../shared/contracts/config.js'
import type { NativeWorkspaceRecord } from '../native-workspace-store.js'
import { SettingsToggleRow } from '../settings-controls.js'
import { normalizeAssistantNotificationSettings } from '../../shared/assistant-notifications.js'

/** 创建与配置共用形象选择：选中 Live2D 时先确认引擎许可并自动安装，成功后才改草稿。 */
function AssistantAvatarSelectionField({ services, appearance, avatarId, avatars, includeLegacy, disabled, t, onChange }: {
  readonly services: CodingNsClientServices
  readonly appearance: ReturnType<typeof normalizeAssistantAppearance>
  readonly avatarId: string
  readonly avatars: readonly AssistantAvatarModel[]
  readonly includeLegacy: boolean
  readonly disabled: boolean
  readonly t: CodingNsTranslator
  readonly onChange: (patch: Partial<AssistantDraft>) => void
}): ReactElement {
  const manager = getAssistantAvatarManager(services)
  const engine = useAssistantAvatarEngine({ services, manager, appearance, disabled })
  const choices = assistantAvatarChoices(appearance, [], t, includeLegacy)
  const avatar = avatars.find((model) => model.id === avatarId)
  const list = choices.some((choice) => choice.id === avatarId) ? choices
    : [{ id: avatarId, label: t('awb.unavailableSelection', { id: avatarId }), thirdParty: false, disabled: true }, ...choices]
  const choose = (choice: { readonly id: string }): void => {
    if (disabled || !avatars.some((model) => model.id === choice.id)) return
    const model = avatars.find((item) => item.id === choice.id)
    if (model?.renderer === 'live2d') { void engine.ensure(() => onChange({ avatarId: choice.id })); return }
    onChange({ avatarId: choice.id })
  }
  return createElement('div', { style: { display: 'grid', gap: 8 } },
    createElement(AssistantAvatarPicker, { label: t('awb.avatar'), value: avatarId, disabled: disabled || engine.installing, t, choices: list, onChoose: choose }),
    createElement(AssistantAvatarEngineProgress, { controller: engine, t }),
    createElement('p', { style: help }, t('avatar.externalHint')),
    avatar?.renderer !== 'live2d' ? null : createElement('p', { style: help }, t('avatar.live2dDependencyHint')),
    createElement(AssistantAvatarEngineDialog, { controller: engine, t }))
}

export function AssistantConfigurationFields({ draft, catalog, appearance, initializing = false, includeAvatar = true, services, t, disabled, onChange }: {
  readonly draft: AssistantDraft; readonly catalog: AssistantChatCatalog | undefined
  readonly appearance: ReturnType<typeof normalizeAssistantAppearance>; readonly t: CodingNsTranslator
  readonly initializing?: boolean
  readonly includeAvatar?: boolean
  readonly services?: CodingNsClientServices
  readonly disabled: boolean; readonly onChange: (patch: Partial<AssistantDraft>) => void
}): ReactElement {
  const models = catalog?.models ?? []; const avatars = listAssistantAvatars(appearance, !initializing)
  const avatar = avatars.find((model) => model.id === draft.avatarId)
  const avatarChoices = assistantAvatarChoices(appearance, [], t, !initializing)
  const input = (label: string, node: ReactElement): ReactElement => createElement('label', { style: field }, createElement('span', null, label), node)
  const select = (label: string, value: string, change: (value: string) => void, options: ReactElement[]): ReactElement => input(label, createElement('select', { value, disabled, style: identityFieldStyle, onChange: (event: { currentTarget: { value: string } }) => change(event.currentTarget.value) }, ...options))
  const missing = (id: string): ReactElement => createElement('option', { key: id, value: id }, t('awb.unavailableSelection', { id }))
  return createElement('div', { 'data-codingns-assistant-identity': true, style: { display: 'grid', gap: 11 } },
    // 名称与头像始终左右排列，裁剪面板和本地保存说明跨两列展开。
    createElement('div', { 'data-codingns-assistant-identity-row': true, style: { display: 'grid', alignItems: 'start',
      gridTemplateColumns: services === undefined || avatar === undefined ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) minmax(0, 176px)', columnGap: 16, rowGap: 8, minWidth: 0 } },
      input(t('awb.name'), createElement('input', { value: draft.name, maxLength: 80, disabled, placeholder: t('awb.namePlaceholder'), style: identityFieldStyle, onChange: (event: { currentTarget: { value: string } }) => onChange({ name: event.currentTarget.value }) })),
      services === undefined || avatar === undefined ? null : createElement(AssistantAvatarPortraitEditor, { services, model: avatar, disabled, t })),
    select(t('awb.model'), draft.modelKey, (modelKey) => onChange({ modelKey }), [createElement('option', { key: '', value: '' }, t('awb.defaultModel')),
      ...(draft.modelKey && !models.some((model) => JSON.stringify([model.provider, model.model]) === draft.modelKey) ? [missing(draft.modelKey)] : []),
      ...models.map((model) => createElement('option', { key: JSON.stringify([model.provider, model.model]), value: JSON.stringify([model.provider, model.model]) }, `${model.label} · ${model.provider}`))]),
    catalog?.models.length === 0 ? createElement('p', { style: help }, t('awb.noModel'), ...catalog.errors.map((error) => createElement('span', { key: error, style: { display: 'block' } }, error))) : null,
    input(t('awb.personality'), createElement('textarea', { value: draft.personality, maxLength: ASSISTANT_PERSONALITY_MAX_CHARS, rows: 4, disabled, placeholder: t('awb.personalityPlaceholder'),
      style: { ...identityFieldStyle, minHeight: 96, maxHeight: 200, resize: 'vertical', lineHeight: 1.65 }, onChange: (event: { currentTarget: { value: string } }) => onChange({ personality: event.currentTarget.value }) })),
    !includeAvatar ? null : services === undefined ? createElement('div', { style: { display: 'grid', gap: 8 } },
      createElement(AssistantAvatarPicker, { label: t('awb.avatar'), value: draft.avatarId, disabled, t,
        choices: avatarChoices.some((choice) => choice.id === draft.avatarId) ? avatarChoices
          : [{ id: draft.avatarId, label: t('awb.unavailableSelection', { id: draft.avatarId }), thirdParty: false, disabled: true }, ...avatarChoices],
        onChoose: (choice) => { if (avatars.some((avatar) => avatar.id === choice.id)) onChange({ avatarId: choice.id }) } }),
      createElement('p', { style: help }, t('avatar.externalHint')),
      avatar?.renderer !== 'live2d' ? null : createElement('p', { style: help }, t('avatar.live2dDependencyHint')))
      : createElement(AssistantAvatarSelectionField, { services, appearance, avatarId: draft.avatarId, avatars, includeLegacy: !initializing, disabled, t, onChange }))
}

/** 创建后的各页只装配自己的字段；页面切换不持有或重置父级草稿。 */
export function AssistantConfigurationPage({ tab, active = true, services, value, draft, catalog, appearance, tts, workspaces, t, disabled, onChange, onDebug, onError, onReset, ...previewProps }: {
  readonly tab: AssistantConfigurationTab; readonly services: CodingNsClientServices; readonly value: AssistantSettings
  readonly active?: boolean
  readonly draft: AssistantDraft; readonly catalog: AssistantChatCatalog | undefined
  readonly appearance: ReturnType<typeof normalizeAssistantAppearance>; readonly tts: AssistantTtsSnapshot | undefined
  readonly workspaces: readonly NativeWorkspaceRecord[]; readonly t: CodingNsTranslator; readonly disabled: boolean
  readonly onChange: (patch: Partial<AssistantDraft>) => void
  readonly onDebug: () => void; readonly onError: (error: string) => void
  readonly onReset?: () => void
} & Omit<AssistantAvatarPreviewTargetProps, 'active'>): ReactElement {
  switch (tab) {
    case 'basic': return createElement(AssistantConfigurationFields, { draft, catalog, appearance, includeAvatar: false, services, t, disabled, onChange })
    case 'appearance': return createElement('div', { style: { display: 'grid', gap: 11 } },
      createElement(AssistantAppearanceEditor, { services, enabled: !disabled, active, ...previewProps }))
    case 'voice': return createElement('div', { style: { display: 'grid', gap: 11 } },
      createElement(AssistantVoiceInitializationPanel, { services, enabled: !disabled, active,
        inputSettings: (groupActive) => createElement('div', { style: { display: 'grid', gap: 11 } },
          createElement(AssistantAudioDevice, { services, direction: 'input', active: groupActive, disabled, t, onError }),
          createElement(VoiceModelManagerPanel, { services, value: value.voice, enabled: !disabled, active: groupActive })),
        outputSettings: (groupActive) => createElement('div', { style: { display: 'grid', gap: 11 } },
          createElement(AssistantAudioDevice, { services, direction: 'output', active: groupActive, disabled, t, onError }),
          createElement(AssistantVoiceSettings, { services, enabled: !disabled, active: groupActive, embedded: true })) }))
    case 'more': return createElement('div', { style: { display: 'grid', gap: 11 } },
      createElement(AssistantWorkspaceFields, { draft, workspaces, t, disabled, onChange }),
      createElement(AssistantNotificationSettings, { services, value, disabled, t, onError }),
      createElement(AssistantAdvancedSettings, { services, value, disabled, t, onDebug, onError }),
      createElement('div', { style: { paddingTop: 16, borderTop: `1px solid ${dshThemeColor.border}` } },
        createElement('button', { type: 'button', 'data-codingns-assistant-reset': true, disabled: disabled || onReset === undefined,
          style: { ...dshSettingsButtonStyle, color: dshThemeColor.error }, onClick: onReset }, t('awb.reset'))))
  }
}

/** 兼容原能力表单入口；实际配置页分别装配项目字段与声音字段。 */
export function AssistantCapabilityFields({ draft, tts, workspaces, t, disabled, onChange }: {
  readonly draft: AssistantDraft; readonly tts: AssistantTtsSnapshot | undefined; readonly workspaces: readonly NativeWorkspaceRecord[]; readonly t: CodingNsTranslator
  readonly disabled: boolean; readonly onChange: (patch: Partial<AssistantDraft>) => void
}): ReactElement {
  return createElement('div', { style: { display: 'grid', gap: 18 } },
    AssistantWorkspaceFields({ draft, workspaces, t, disabled, onChange }), AssistantVoiceFields({ draft, tts, t, disabled, onChange }))
}

/** 项目范围放到更多设置，保留暂不可用项目以避免编辑时丢失原有选择。 */
export function AssistantWorkspaceFields({ draft, workspaces, t, disabled, onChange }: {
  readonly draft: AssistantDraft; readonly workspaces: readonly NativeWorkspaceRecord[]; readonly t: CodingNsTranslator
  readonly disabled: boolean; readonly onChange: (patch: Partial<AssistantDraft>) => void
}): ReactElement {
  const knownWorkspaces = new Set(workspaces.map((workspace) => workspace.workspaceId))
  return createElement('fieldset', { 'data-codingns-assistant-projects': true, style: { border: 0, padding: 0, margin: 0, minWidth: 0 }, disabled },
    createElement('legend', { style: { fontSize: 14, fontWeight: 600, padding: 0, marginBottom: 8 } }, t('awb.workspaces')),
    createElement('p', { style: help }, t('awb.scopeHint')),
    createElement('div', { style: { display: 'grid', gap: 8, maxHeight: 180, overflowY: 'auto', marginTop: 8 } },
      ...[...workspaces, ...draft.managedWorkspaceIds.filter((id) => !knownWorkspaces.has(id)).map((workspaceId) => ({ workspaceId, title: t('awb.offlineWorkspace', { id: workspaceId }) }))].map((workspace) => createElement('label', { key: workspace.workspaceId, style: assistantSettingCheckboxStyle },
        createElement('input', { type: 'checkbox', checked: draft.managedWorkspaceIds.includes(workspace.workspaceId), onChange: (event: { currentTarget: { checked: boolean } }) => onChange({ managedWorkspaceIds: event.currentTarget.checked ? [...draft.managedWorkspaceIds, workspace.workspaceId] : draft.managedWorkspaceIds.filter((id) => id !== workspace.workspaceId) }) }), workspace.title))))
}

/** 没有安装 MOSS 时只有浏览器声音可选，不因标签拆分而放宽可用性校验。 */
export function AssistantVoiceFields({ draft, tts, t, disabled, onChange }: {
  readonly draft: AssistantDraft; readonly tts: AssistantTtsSnapshot | undefined; readonly t: CodingNsTranslator
  readonly disabled: boolean; readonly onChange: (patch: Partial<AssistantDraft>) => void
}): ReactElement {
  const mossReady = tts?.status.ready === true
  const voices = mossReady ? tts.voices : []
  return createElement('div', { 'data-codingns-assistant-voice-selection': true, style: { display: 'grid', gap: 10 } },
    createElement('label', { style: field }, createElement('span', null, t('awb.voice')),
      createElement('select', { value: draft.ttsBackend === 'browser' || !mossReady ? 'browser' : draft.voiceId, disabled, style: identityFieldStyle,
        onChange: (event: { currentTarget: { value: string } }) => { const voice = event.currentTarget.value; if (voice === 'browser') onChange({ ttsBackend: 'browser' }); else if (mossReady && voices.some((item) => item.id === voice)) onChange({ ttsBackend: 'moss-onnx', voiceId: voice }) } },
        createElement('option', { value: 'browser' }, t('awb.browserVoice')), ...voices.map((voice) => createElement('option', { key: voice.id, value: voice.id }, voice.name)))),
    mossReady ? null : createElement('p', { style: help }, t('awb.mossSetupHint')))
}
function AssistantAdvancedSettings({ services, value, disabled, t, onDebug, onError }: { readonly services: CodingNsClientServices; readonly value: AssistantSettings; readonly disabled: boolean; readonly t: CodingNsTranslator; readonly onDebug: () => void; readonly onError: (error: string) => void }): ReactElement {
  const defaults = readAssistantPrompts(value.prompts)
  const prompts = services.configurationDraft ? { ...defaults, ...value.prompts } : defaults
  const savePrompt = async (kind: 'index' | 'chat', text: string): Promise<void> => {
    // 提示词是单字段绝对值，不依赖旧快照计算；后台索引变化不应阻止保存。
    try { if (!await services.settings.mutate([{ op: 'set', path: ['assistant', 'prompts', kind], value: text }])) throw new Error(t('settings.moduleWriteRejected')) }
    catch (cause) { onError(message(cause)); throw cause }
  }
  return createElement('div', { style: { display: 'grid', gap: 14, marginTop: 14 } },
    createElement('p', { style: help }, t('awb.moreHint')),
    ...(['index', 'chat'] as const).map((kind) => createElement(AssistantPromptEditor, { key: kind, kind, value: prompts[kind], disabled, onSave: savePrompt,
      ...(services.configurationDraft ? { onChange: savePrompt } : {}), t })),
    createElement('button', { type: 'button', disabled, style: dshSettingsButtonStyle, onClick: onDebug }, t('assistant.debug.open')))
}

/** 设备按输入、输出分组枚举，折叠时保留选择但停止设备查询。 */
function AssistantAudioDevice({ services, direction, active, disabled, t, onError }: {
  readonly services: CodingNsClientServices; readonly direction: 'input' | 'output'; readonly active: boolean
  readonly disabled: boolean; readonly t: CodingNsTranslator; readonly onError: (error: string) => void
}): ReactElement | null {
  const adapter = getGlobalVoiceAdapter(services)
  const output = direction === 'output'
  const [devices, setDevices] = useState<readonly { deviceId: string; label: string }[]>([])
  const [selectedId, setSelectedId] = useState((output ? adapter?.outputDeviceId : adapter?.inputDeviceId) ?? '')
  useEffect(() => {
    if (!active || (output && !adapter?.outputDeviceSupported)) return undefined
    let stopped = false
    const refresh = (): void => { void (output ? adapter?.enumerateOutputDevices() : adapter?.enumerateInputDevices())?.then((devices) => { if (!stopped) setDevices(devices) }).catch(() => undefined) }
    refresh(); globalThis.navigator?.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => { stopped = true; globalThis.navigator?.mediaDevices?.removeEventListener?.('devicechange', refresh) }
  }, [active, adapter, output])
  if (output && !adapter?.outputDeviceSupported) return null
  return createElement('label', { style: field }, t(output ? 'voice.outputDevice' : 'voice.inputDevice'),
    createElement('select', { disabled, value: selectedId, style: dshSettingsFieldStyle, onChange: (event: { currentTarget: { value: string } }) => {
      const id = event.currentTarget.value
      void (output ? adapter?.selectOutputDevice(id) : adapter?.selectInputDevice(id))?.then(() => setSelectedId(id)).catch((cause) => onError(message(cause)))
    } }, createElement('option', { value: '' }, t(output ? 'voice.defaultOutput' : 'voice.defaultMicrophone')), ...devices.map((device) => createElement('option', { key: device.deviceId, value: device.deviceId }, device.label || t(output ? 'voice.unnamedOutput' : 'voice.unnamedMicrophone')))))
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
const help: CSSProperties = { ...dshSettingsHelpStyle, margin: 0 }
const field: CSSProperties = assistantSettingFieldStyle
const identityFieldStyle: CSSProperties = { ...dshSettingsFieldStyle, borderRadius: 8 }
