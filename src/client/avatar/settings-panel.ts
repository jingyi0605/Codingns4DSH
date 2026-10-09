import { createElement, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { ASSISTANT_AVATAR_FLOATING_MINI_SIZE, ASSISTANT_AVATAR_FLOATING_STANDARD_SIZE, ASSISTANT_AVATAR_MAX_MODELS, getBuiltinAssistantAvatar, isAssistantAvatarSource, selectedAssistantAvatar } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarModel } from '../../shared/assistant-avatar.js'
import type { CodingNsClientServices, FeaturePanelProps, SettingsNotice } from '../features/types.js'
import { useCodingNsTranslator, type CodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsHelpStyle, dshSettingsFieldStyle, dshThemeColor } from '../theme.js'
import { getAssistantAvatarManager } from './manager.js'
import { getAssistantAvatarRegistry } from './registry.js'
import type { AssistantAvatarCandidate } from '../../shared/assistant-avatar-installation.js'
import { AssistantAvatarCatalogPanel } from './catalog-panel.js'
import type { AssistantAvatarPreviewTargetProps } from './catalog-panel.js'
import { AssistantAvatarEngineDialog, AssistantAvatarEngineProgress, useAssistantAvatarEngine } from './engine.js'
import { assistantSettingFieldStyle, assistantSettingSwitchStyle, assistantSettingTextStyle } from '../assistant-settings-styles.js'
import { SettingsSwitch } from '../settings-controls.js'

/** 对话内复用设置页表单；订阅同一存储并把保存反馈留在当前窗口。 */
export function AssistantAppearanceEditor({ services, enabled, ...previewProps }: {
  readonly services: CodingNsClientServices
  readonly enabled: boolean
} & AssistantAvatarPreviewTargetProps): ReactElement {
  const store = services.settings
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store])
  const getSnapshot = useCallback(() => store.getSnapshot(), [store])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [notice, setNotice] = useState<SettingsNotice | undefined>()
  return createElement('div', { 'data-codingns-avatar-settings-editor': true, style: { display: 'grid', gap: 10 } },
    createElement(AssistantAppearancePanel, { services, enabled, snapshot, notify: setNotice, ...previewProps }),
    // 表单本身已显示失败信息，外层只补充保存成功反馈，避免重复错误提示。
    notice?.kind !== 'success' ? null : createElement('div', { role: 'status',
      style: { fontSize: 13, color: dshThemeColor.success } }, notice.message),
  )
}

/** 保存只写 appearance 子字段，不覆盖其他窗口刚改过的语音或受管范围。 */
export function AssistantAppearancePanel({ services, enabled, snapshot, notify, ...previewProps }: FeaturePanelProps & AssistantAvatarPreviewTargetProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const manager = getAssistantAvatarManager(services)
  const appearance = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot)
  const selected = selectedAssistantAvatar(appearance)
  const registry = getAssistantAvatarRegistry(services)
  const adapters = useSyncExternalStore(manager.adapters.subscribe, manager.adapters.getSnapshot, manager.adapters.getSnapshot)
  const renderers = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [renderer, setRenderer] = useState('image')
  const [version, setVersion] = useState<1 | 2>(2)
  const [error, setError] = useState('')
  const [manifestUrl, setManifestUrl] = useState('')
  const [adapterId, setAdapterId] = useState('auto')
  const [candidates, setCandidates] = useState<readonly AssistantAvatarCandidate[]>([])
  const [candidateUrl, setCandidateUrl] = useState('')
  const [addMode, setAddMode] = useState<'package' | 'custom'>('package')
  const [customSize, setCustomSize] = useState(false)
  const importer = useRef<AbortController | undefined>()
  useEffect(() => () => importer.current?.abort(), [manager])
  const selectedAdapterId = adapters.some((adapter) => adapter.id === adapterId) ? adapterId : 'auto'
  const selectedRenderer = renderers.some((item) => item.id === renderer && item.id !== 'builtin') ? renderer : 'image'
  const disabled = !enabled || pending || snapshot.status !== 'ready' || !snapshot.writable
  const engine = useAssistantAvatarEngine({ services, manager, appearance, disabled, notify })
  const save = async (action: () => Promise<unknown>, message = t('avatar.saved')): Promise<boolean> => {
    if (disabled) return false
    setPending(true); setError('')
    try {
      await action()
      if (!services.configurationDraft) notify({ kind: 'success', message })
      return true
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') { notify({ kind: 'info', message: t('avatar.cancelled') }); return false }
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message); notify({ kind: 'error', message })
      return false
    } finally { setPending(false) }
  }
  const add = async (): Promise<void> => {
    if (!isAssistantAvatarSource(source.trim())) { setError(t('avatar.invalidSource')); return }
    const id = `avatar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const model: AssistantAvatarModel = { id, name: name.trim() || t('avatar.customName'), renderer: selectedRenderer,
      source: source.trim(), spriteVersion: version }
    // 自定义 Live2D 素材同样需要引擎：确认许可后自动安装，失败不写入形象。
    const accepted = selectedRenderer === 'live2d'
      ? await engine.ensure(async () => {
        await manager.add(model)
        if (!services.configurationDraft) notify({ kind: 'success', message: t('avatar.saved') })
      })
      : await save(() => manager.add(model))
    if (accepted) { setName(''); setSource('') }
  }
  const importPackage = async (): Promise<void> => {
    if (!isAssistantAvatarSource(manifestUrl.trim())) { setError(t('avatar.invalidSource')); return }
    const controller = new AbortController()
    importer.current = controller
    const accepted = await save(async () => {
      const discovered = await manager.discover(manifestUrl.trim(), controller.signal)
      setCandidates(discovered); setCandidateUrl(discovered[0]?.url ?? '')
    }, t('avatar.discovered'))
    if (importer.current === controller) importer.current = undefined
    if (!accepted) { setCandidates([]); setCandidateUrl('') }
  }
  const installPackage = async (url: string): Promise<void> => {
    const controller = new AbortController()
    importer.current = controller
    const accepted = await save(() => manager.installPackage(url, selectedAdapterId, controller.signal))
    if (importer.current === controller) importer.current = undefined
    if (accepted) { setManifestUrl(''); setCandidates([]); setCandidateUrl('') }
  }
  const field = (label: string, input: ReactElement): ReactElement => createElement('label', { style: assistantSettingFieldStyle },
    createElement('span', null, label), input)
  const toggle = (key: 'floatingEnabled' | 'dialogEnabled', label: string): ReactElement => createElement('label', {
    style: assistantSettingSwitchStyle },
    createElement('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, label), createElement(SettingsSwitch, { 'aria-label': label,
      checked: appearance[key], disabled, onChange: (event: { currentTarget: { checked: boolean } }) => { const checked = event.currentTarget.checked; void save(() => manager.configure({ [key]: checked })) } }))
  const sizeField = (key: 'floatingSize' | 'dialogSize', min: number, max: number, label: string): ReactElement => field(label,
    createElement('input', { key: appearance[key], type: 'number', min, max, step: 1, defaultValue: appearance[key], disabled, 'aria-label': label, style: dshSettingsFieldStyle,
      onBlur: (event: { currentTarget: { value: string } }) => { const value = Number(event.currentTarget.value); if (Number.isInteger(value) && value >= min && value <= max && value !== appearance[key]) void save(() => manager.configure({ [key]: value })); else event.currentTarget.value = String(appearance[key]) } }))
  return createElement('section', { 'aria-label': t('avatar.settingsTitle'), style: { ...assistantSettingTextStyle, display: 'grid', gap: 12, borderTop: `1px solid ${dshThemeColor.border}`, paddingTop: 14 } },
    createElement('strong', { style: { fontSize: 14 } }, t('avatar.settingsTitle')),
    createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('avatar.settingsDescription')),
    createElement(AssistantAvatarCatalogPanel, { services, manager, appearance, disabled, notify, ...previewProps }),
    createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('avatar.externalHint')),
    selected.renderer !== 'live2d' ? null : createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('avatar.live2dDependencyHint')),
    selected.package === undefined ? null : createElement('div', { 'data-codingns-avatar-package-info': true, style: { ...dshSettingsHelpStyle, overflowWrap: 'anywhere' } },
      createElement('div', null, t('avatar.packageAuthor', { author: selected.package.author || t('avatar.notDeclared') })),
      createElement('div', null, t('avatar.packageLicense', { license: selected.package.license || t('avatar.notDeclared') })),
      selected.package.manifestUrl === undefined ? null : createElement('a', { href: selected.package.manifestUrl, target: '_blank', rel: 'noopener noreferrer' }, t('avatar.packageSource')),
      selected.package.homepage === undefined ? null : createElement('div', null, createElement('a', { href: selected.package.homepage, target: '_blank', rel: 'noopener noreferrer' }, t('avatar.packageHomepage')))),
    toggle('floatingEnabled', t('avatar.floatingEnabled')),
    createElement(AssistantFloatingSizeControl, { size: appearance.floatingSize, custom: customSize, disabled, t,
      onPreset: (preset) => { setCustomSize(preset === 'custom'); if (preset !== 'custom') void save(() => manager.configure({ floatingSize: preset === 'mini' ? ASSISTANT_AVATAR_FLOATING_MINI_SIZE : ASSISTANT_AVATAR_FLOATING_STANDARD_SIZE })) },
      onSize: (floatingSize) => { void save(() => manager.configure({ floatingSize })) } }),
    toggle('dialogEnabled', t('avatar.dialogEnabled')),
    sizeField('dialogSize', 120, 480, t('avatar.dialogSize')),
    getBuiltinAssistantAvatar(appearance.selectedId) !== undefined ? null : createElement('button', { type: 'button', disabled, style: { ...dshSettingsButtonStyle, justifySelf: 'start' },
      onClick: () => { const id = appearance.selectedId; void save(() => manager.remove(id)) } }, t('avatar.remove')),
    selected.package?.manifestUrl === undefined || selected.package.installationId !== undefined ? null : createElement('button', {
      type: 'button', disabled, style: { ...dshSettingsButtonStyle, justifySelf: 'start' },
      onClick: () => { void installPackage(selected.package!.manifestUrl!) },
    }, t('avatar.installCurrent')),
    createElement('details', { 'data-codingns-avatar-add': true }, createElement('summary', { style: { cursor: 'pointer', fontSize: 13 } }, t('avatar.add')),
      field(t('avatar.addMode'), createElement('select', { value: addMode, disabled, style: { ...dshSettingsFieldStyle, marginTop: 12 },
        'data-codingns-avatar-add-mode': true,
        onChange: (event: { currentTarget: { value: string } }) => setAddMode(event.currentTarget.value === 'custom' ? 'custom' : 'package') },
        createElement('option', { value: 'package' }, t('avatar.importPackage')), createElement('option', { value: 'custom' }, t('avatar.customMaterial')))),
      addMode !== 'package' ? null : createElement('div', { 'data-codingns-avatar-package-import': true, style: { display: 'grid', gap: 12, marginTop: 12 } },
        field(t('avatar.adapter'), createElement('select', { value: selectedAdapterId, disabled, style: dshSettingsFieldStyle,
          onChange: (event: { currentTarget: { value: string } }) => setAdapterId(event.currentTarget.value) },
          createElement('option', { value: 'auto' }, t('avatar.adapter.auto')),
          ...adapters.map((adapter) => createElement('option', { key: adapter.id, value: adapter.id }, adapter.labelKey === undefined ? adapter.name ?? adapter.id : t(adapter.labelKey))))),
        field(t('avatar.manifestUrl'), createElement('input', { value: manifestUrl, disabled, maxLength: 2048, style: dshSettingsFieldStyle,
          onChange: (event: { currentTarget: { value: string } }) => { setManifestUrl(event.currentTarget.value); setCandidates([]); setCandidateUrl('') } })),
        createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('avatar.importHint')),
        createElement('button', { type: 'button', disabled, style: { ...dshSettingsButtonStyle, justifySelf: 'start' }, onClick: () => { void importPackage() } }, pending && importer.current !== undefined ? t('avatar.importing') : t('avatar.discover')),
        candidates.length === 0 ? null : field(t('avatar.installCandidate'), createElement('select', { value: candidateUrl, disabled,
          style: dshSettingsFieldStyle, onChange: (event: { currentTarget: { value: string } }) => setCandidateUrl(event.currentTarget.value) },
          ...candidates.map((candidate) => createElement('option', { key: candidate.url, value: candidate.url }, candidate.name)))),
        candidates.length === 0 ? null : createElement('button', { type: 'button', disabled: disabled || appearance.models.length >= ASSISTANT_AVATAR_MAX_MODELS,
          style: { ...dshSettingsButtonStyle, justifySelf: 'start' }, onClick: () => { void installPackage(candidateUrl) } }, t('avatar.importUse')),
        !pending || importer.current === undefined ? null : createElement('div', { role: 'status', style: { display: 'grid', gap: 8 } },
          createElement('span', null, t('avatar.installProgress')),
          createElement('progress', { 'aria-label': t('avatar.installProgress'), style: { width: '100%' } }),
          createElement('button', { type: 'button', style: { ...dshSettingsButtonStyle, justifySelf: 'start' },
            onClick: () => importer.current?.abort() }, t('avatar.cancel')))),
      addMode !== 'custom' ? null : createElement('div', { 'data-codingns-avatar-custom-add': true, style: { display: 'grid', gap: 12, marginTop: 12 } },
        field(t('avatar.name'), createElement('input', { value: name, disabled, maxLength: 80, style: dshSettingsFieldStyle, onChange: (event: { currentTarget: { value: string } }) => setName(event.currentTarget.value) })),
        field(t('avatar.type'), createElement('select', { value: selectedRenderer, disabled, style: dshSettingsFieldStyle, onChange: (event: { currentTarget: { value: string } }) => setRenderer(event.currentTarget.value) },
          ...renderers.filter((item) => item.id !== 'builtin').map((item) => createElement('option', { key: item.id, value: item.id }, item.labelKey === undefined ? item.name ?? item.id : t(item.labelKey))))),
        field(t('avatar.source'), createElement('input', { value: source, disabled, maxLength: 2048, type: 'text', style: dshSettingsFieldStyle, onChange: (event: { currentTarget: { value: string } }) => setSource(event.currentTarget.value) })),
        createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t(['image', 'spritesheet', 'live2d'].includes(selectedRenderer) ? `avatar.sourceHint.${selectedRenderer}` : 'avatar.sourceHint.custom')),
        selectedRenderer !== 'live2d' ? null : createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0 } }, t('avatar.live2dDependencyHint')),
        selectedRenderer !== 'spritesheet' ? null : field(t('avatar.spriteVersion'), createElement('select', { value: version, disabled, style: dshSettingsFieldStyle,
          onChange: (event: { currentTarget: { value: string } }) => setVersion(event.currentTarget.value === '1' ? 1 : 2) },
          createElement('option', { value: 1 }, 'v1 · 1536×1872'), createElement('option', { value: 2 }, 'v2 · 1536×2288'))),
        createElement('button', { type: 'button', disabled: disabled || appearance.models.length >= ASSISTANT_AVATAR_MAX_MODELS, onClick: () => { void add() }, style: { ...dshSettingsButtonStyle, justifySelf: 'start' } }, t('avatar.addUse')),
      )),
    createElement(AssistantAvatarEngineProgress, { controller: engine, t }),
    error === '' ? null : createElement('div', { role: 'alert', style: { color: dshThemeColor.error, fontSize: 13 } }, error),
    createElement(AssistantAvatarEngineDialog, { controller: engine, t }),
  )
}

/** 以数值判断旧配置的档位；选择自定义时才展开输入框，不增加持久字段。 */
export function AssistantFloatingSizeControl({ size, custom, disabled, t, onPreset, onSize }: {
  readonly size: number; readonly custom: boolean; readonly disabled: boolean; readonly t: CodingNsTranslator
  readonly onPreset: (preset: 'mini' | 'standard' | 'custom') => void; readonly onSize: (size: number) => void
}): ReactElement {
  const preset = custom ? 'custom' : size === ASSISTANT_AVATAR_FLOATING_MINI_SIZE ? 'mini' : size === ASSISTANT_AVATAR_FLOATING_STANDARD_SIZE ? 'standard' : 'custom'
  const label = t('avatar.floatingSize')
  return createElement('div', { 'data-codingns-avatar-floating-size': true, style: { display: 'grid', gap: 8 } },
    createElement('label', { style: assistantSettingFieldStyle }, label,
      createElement('select', { value: preset, disabled, 'aria-label': label, style: dshSettingsFieldStyle,
        onChange: (event: { currentTarget: { value: string } }) => { const next = event.currentTarget.value; if (next === 'mini' || next === 'standard' || next === 'custom') onPreset(next) } },
        createElement('option', { value: 'mini' }, t('avatar.size.mini')), createElement('option', { value: 'standard' }, t('avatar.size.standard')),
        createElement('option', { value: 'custom' }, t('avatar.size.custom')))),
    preset !== 'custom' ? null : createElement('label', { style: assistantSettingFieldStyle }, t('avatar.customSize'),
      createElement('input', { key: size, type: 'number', min: ASSISTANT_AVATAR_FLOATING_MINI_SIZE, max: 320, step: 1,
        defaultValue: size, disabled, 'aria-label': t('avatar.customSize'), style: dshSettingsFieldStyle,
        onBlur: (event: { currentTarget: { value: string } }) => {
          const value = Number(event.currentTarget.value)
          if (!disabled && Number.isInteger(value) && value >= ASSISTANT_AVATAR_FLOATING_MINI_SIZE && value <= 320 && value !== size) onSize(value)
          else event.currentTarget.value = String(size)
        } })))
}
