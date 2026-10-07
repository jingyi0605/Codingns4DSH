import { createElement, useEffect, useId, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { ASSISTANT_AVATAR_CONSENT_VERSION, hasAssistantAvatarConsent } from '../../shared/assistant-avatar-catalog.js'
import type { AssistantAvatarCatalogEntry, AssistantAvatarTemporaryPreview } from '../../shared/assistant-avatar-catalog.js'
import { ASSISTANT_AVATAR_MAX_MODELS } from '../../shared/assistant-avatar.js'
import type { AssistantAppearanceSettings } from '../../shared/assistant-avatar.js'
import type { CodingNsClientServices, SettingsNotice } from '../features/types.js'
import { useCodingNsTranslator, type CodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsPrimaryButtonStyle, dshSettingsHelpStyle, dshThemeColor } from '../theme.js'
import type { AssistantAvatarManager } from './manager.js'
import { assistantSettingCheckboxStyle, assistantSettingSwitchStyle, assistantSettingTextStyle } from '../assistant-settings-styles.js'
import { AssistantAvatarPicker, assistantAvatarChoices, type AssistantAvatarChoice } from './catalog-picker.js'
import { AssistantAvatarSlot } from './slot.js'
import { AssistantAvatarLoading } from './loading.js'
import { startAssistantAvatarTemporaryPreview } from './temporary-preview.js'

export interface AssistantAvatarPreviewTargetProps {
  readonly active?: boolean
  readonly previewTarget?: Element | null
  readonly onPreviewChange?: (entry: AssistantAvatarCatalogEntry | undefined) => void
}

interface CatalogPanelProps extends AssistantAvatarPreviewTargetProps {
  readonly services: CodingNsClientServices
  readonly manager: AssistantAvatarManager
  readonly appearance: AssistantAppearanceSettings
  readonly disabled: boolean
  readonly notify: (notice: SettingsNotice) => void
}
const buttonStyle = { ...dshSettingsButtonStyle, justifySelf: 'start' }
const helpStyle = { ...dshSettingsHelpStyle, margin: 0 }
const checkStyle = assistantSettingCheckboxStyle

/** 目录与已登记角色共用选择入口，协议和素材安装仍分别确认。 */
export function AssistantAvatarCatalogPanel(props: CatalogPanelProps): ReactElement {
  const { services, manager, appearance, disabled, notify, active = true, previewTarget, onPreviewChange } = props
  const t = useCodingNsTranslator(services.locale)
  const [agreed, setAgreed] = useState(false)
  const [agreementOpen, setAgreementOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [preview, setPreview] = useState<{ readonly id: string; readonly consent: string; readonly selection: number } | undefined>()
  const [error, setError] = useState('')
  const accepted = hasAssistantAvatarConsent(appearance.thirdPartyConsent)
  const consent = accepted ? `${appearance.thirdPartyConsent!.version}:${appearance.thirdPartyConsent!.acceptedAt}` : ''
  const catalog = useAssistantAvatarCatalog(manager, consent)
  const choices = assistantAvatarChoices(appearance, catalog.entries, t)
  const selected = preview?.consent === consent ? catalog.entries.find((entry) => entry.id === preview.id) : undefined
  useEffect(() => {
    onPreviewChange?.(active ? selected : undefined)
    return () => onPreviewChange?.(undefined)
  }, [active, selected, onPreviewChange])
  const busy = disabled || pending || installing
  const choose = async (choice: AssistantAvatarChoice): Promise<void> => {
    if (busy) return
    setError('')
    if (choice.catalog !== undefined) {
      const id = choice.catalog.id
      // 重新选择同一条目也创建新预览，允许失败后直接重试。
      setPreview((current) => ({ id, consent, selection: (current?.selection ?? 0) + 1 })); return
    }
    setPreview(undefined); setPending(true)
    try { await manager.select(choice.id); if (!services.configurationDraft) notify({ kind: 'success', message: t('avatar.saved') }) }
    catch (failure) { setError(errorMessage(failure)); notify({ kind: 'error', message: errorMessage(failure) }) }
    finally { setPending(false) }
  }
  const changeConsent = async (enabled: boolean): Promise<void> => {
    if (busy || (enabled && !agreed)) return
    setPending(true); setError('')
    try { await manager.setThirdPartyEnabled(enabled); setAgreed(false); setAgreementOpen(false) }
    catch (failure) { setError(errorMessage(failure)); notify({ kind: 'error', message: errorMessage(failure) }) }
    finally { setPending(false) }
  }
  const previewNode = selected === undefined || !active ? null : createElement(AssistantAvatarCatalogPreview, { ...props, selected, disabled: disabled || pending,
    key: `${consent}:${selected.id}:${selected.revision}:${preview?.selection}`, onPending: setInstalling, onInstalled: () => setPreview(undefined) })
  return createElement('section', { 'data-codingns-third-party-avatars': true, 'aria-label': t('avatar.thirdPartyTitle'),
    style: { ...assistantSettingTextStyle, display: 'grid', gap: 20,
      ...(previewNode !== null && !previewTarget ? { gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,260px),1fr))' } : {}) } },
    createElement('div', { style: { display: 'grid', gap: 12, alignContent: 'start' } },
    createElement(AssistantAvatarPicker, { choices, value: selected === undefined ? appearance.selectedId : `catalog-${selected.id}`,
      disabled: busy, t, onChoose: (choice) => { void choose(choice) } }),
    createElement(AssistantAvatarThirdPartyToggle, { accepted, disabled: busy, t,
      onRequest: () => { setAgreed(false); setAgreementOpen(true) }, onDisable: () => { void changeConsent(false) } }),
    !agreementOpen ? null : createElement(AssistantAvatarConsentDialog, { agreed, disabled: busy, t,
      onChange: setAgreed, onAccept: () => { void changeConsent(true) },
      onCancel: () => { if (!pending) { setAgreementOpen(false); setAgreed(false) } } }),
    !catalog.loading ? null : createElement('div', { role: 'status', style: helpStyle }, t('avatar.catalogLoading')),
    !accepted || catalog.loading || catalog.entries.length > 0 || catalog.error ? null : createElement('p', { style: helpStyle }, t(services.configurationDraft ? 'avatar.catalogSaveFirst' : 'avatar.catalogEmpty')),
    !catalog.error ? null : createElement('div', { role: 'alert', style: { display: 'grid', gap: 8, color: dshThemeColor.error, fontSize: 13 } }, catalog.error,
      createElement('button', { type: 'button', disabled: busy || catalog.loading, style: buttonStyle, onClick: catalog.reload }, t('avatar.catalogRetry'))),
    !error ? null : createElement('div', { role: 'alert', style: { color: dshThemeColor.error, fontSize: 13 } }, error)),
    // 工作台使用右侧唯一形象区域；独立设置入口也采用左右分栏，窄屏自然换行。
    previewNode === null ? null : createElement(AssistantAvatarCatalogPreviewRegion, { target: previewTarget, children: previewNode }))
}

/** 预览 DOM 归右侧目标所有，独立设置入口则提供同级侧栏。 */
export function AssistantAvatarCatalogPreviewRegion({ target, children }: { readonly target: Element | null | undefined; readonly children: ReactElement }): ReactElement {
  return target ? createPortal(children, target) : createElement('aside', { 'data-codingns-avatar-preview-region': true }, children)
}

/** 仅有效协议允许读取元数据；协议变化和卸载会取消旧请求并隔离迟到答复。 */
function useAssistantAvatarCatalog(manager: AssistantAvatarManager, consent: string) {
  const [retry, setRetry] = useState(0)
  const [catalog, setCatalog] = useState<{ consent: string; entries: readonly AssistantAvatarCatalogEntry[]; loading: boolean; error: string }>({
    consent: '', entries: [], loading: false, error: '',
  })
  useEffect(() => {
    if (!consent) return
    const controller = new AbortController()
    setCatalog({ consent, entries: [], loading: true, error: '' })
    void manager.getCatalog(controller.signal).then((entries) => {
      if (!controller.signal.aborted) setCatalog({ consent, entries, loading: false, error: '' })
    }).catch((failure) => {
      if (!controller.signal.aborted) setCatalog({ consent, entries: [], loading: false, error: errorMessage(failure) })
    })
    return () => controller.abort()
  }, [manager, consent, retry])
  const current = consent !== '' && catalog.consent === consent
  return { entries: current ? catalog.entries : [], loading: consent !== '' && (!current || catalog.loading),
    error: current ? catalog.error : '', reload: () => setRetry((value) => value + 1) }
}

/** 勾选只请求展示协议，保存同意后才启用；取消不会产生任何设置写入。 */
export function AssistantAvatarThirdPartyToggle({ accepted, disabled, t, onRequest, onDisable }: {
  readonly accepted: boolean; readonly disabled: boolean; readonly t: CodingNsTranslator
  readonly onRequest: () => void; readonly onDisable: () => void
}): ReactElement {
  return createElement('label', { style: assistantSettingSwitchStyle },
    createElement('span', null, t('avatar.thirdPartyEnable')),
    createElement('input', { type: 'checkbox', role: 'switch', 'aria-label': t('avatar.thirdPartyEnable'), checked: accepted, disabled, 'data-codingns-third-party-enabled': true,
      onChange: (event: { currentTarget: { checked: boolean } }) => { if (!disabled) { if (event.currentTarget.checked) onRequest(); else onDisable() } } }))
}

interface ConsentPromptProps {
  readonly agreed: boolean; readonly disabled: boolean; readonly t: CodingNsTranslator
  readonly onChange: (agreed: boolean) => void; readonly onAccept: () => void; readonly onCancel: () => void
}
/** 原生模态对话框限制背景焦点，关闭后恢复到触发协议的复选框。 */
function AssistantAvatarConsentDialog(props: ConsentPromptProps): ReactElement {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    return () => { if (dialog?.open) dialog.close(); if (opener?.isConnected) opener.focus() }
  }, [])
  return createElement('dialog', { ref, 'aria-labelledby': id, 'data-codingns-avatar-consent-dialog': true,
    onCancel: (event: { preventDefault(): void }) => { event.preventDefault(); props.onCancel() },
    onKeyDown: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onCancel() }
    },
    style: { maxWidth: 'min(480px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto',
      boxSizing: 'border-box', padding: 24, borderRadius: 16, margin: 'auto', border: `1px solid ${dshThemeColor.border}`,
      background: dshThemeColor.pageBackground, color: dshThemeColor.labelPrimary, boxShadow: dshThemeColor.subtleShadow } },
    createElement('strong', { id, style: { fontSize: 16 } }, props.t('avatar.thirdPartyTerms', { version: ASSISTANT_AVATAR_CONSENT_VERSION })),
    createElement(AssistantAvatarConsentPrompt, props))
}

export function AssistantAvatarConsentPrompt({ agreed, disabled, t, onChange, onAccept, onCancel }: ConsentPromptProps): ReactElement {
  return createElement('div', { style: { display: 'grid', gap: 16, marginTop: 14 } },
    createElement('p', { style: { ...helpStyle, lineHeight: 1.7 } }, t('avatar.thirdPartyTermsContent')),
    createElement('label', { style: checkStyle },
      createElement('input', { type: 'checkbox', checked: agreed, disabled,
        onChange: (event: { currentTarget: { checked: boolean } }) => { if (!disabled) onChange(event.currentTarget.checked) } }), t('avatar.thirdPartyAgree')),
    createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
      createElement('button', { type: 'button', autoFocus: true, disabled, style: dshSettingsButtonStyle, onClick: onCancel }, t('avatar.cancel')),
      createElement('button', { type: 'button', disabled: disabled || !agreed, style: dshSettingsPrimaryButtonStyle,
        onClick: () => { if (!disabled && agreed) onAccept() } }, t('avatar.thirdPartyConfirm'))))
}

export function AssistantAvatarCatalogPreview({ services, manager, appearance, disabled, notify, selected, onPending, onInstalled }: CatalogPanelProps & {
  readonly selected: AssistantAvatarCatalogEntry
  readonly onPending: (pending: boolean) => void
  readonly onInstalled: () => void
}): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [licenseAccepted, setLicenseAccepted] = useState(false)
  const [temporary, setTemporary] = useState<AssistantAvatarTemporaryPreview | undefined>()
  const [previewLoading, setPreviewLoading] = useState(!disabled)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const installer = useRef<AbortController | undefined>()
  useEffect(() => () => {
    installer.current?.abort()
    onPending(false)
  }, [manager, onPending])
  useEffect(() => {
    setTemporary(undefined); setPreviewLoading(!disabled); setError('')
    if (disabled) return
    // 选择即自动下载临时预览；素材许可只限制正式采用，不锁住左侧选择器。
    const preview = startAssistantAvatarTemporaryPreview(manager, { id: selected.id, revision: selected.revision }, {
      onLoaded: setTemporary,
      onError: (failure) => { setTemporary(undefined); setPreviewLoading(false); setError(errorMessage(failure)) },
      onSettled: () => setPreviewLoading(false),
    })
    return () => { void preview.dispose().catch(() => undefined) }
  }, [manager, disabled, selected.id, selected.revision])
  const installed = appearance.models.some((model) => model.id === `catalog-${selected.id}` && model.package?.installationId !== undefined)
  const full = appearance.models.length >= ASSISTANT_AVATAR_MAX_MODELS && !installed
  const install = async (): Promise<void> => {
    if (disabled || pending || previewLoading || !licenseAccepted || full) return
    const controller = new AbortController()
    installer.current = controller; setPending(true); onPending(true); setError('')
    try {
      await manager.installCatalog(selected.id, selected.revision, licenseAccepted, controller.signal, temporary?.lease)
      if (!controller.signal.aborted) { setLicenseAccepted(false); if (!services.configurationDraft) notify({ kind: 'success', message: t('avatar.saved') }); onInstalled() }
    } catch (failure) {
      if (!controller.signal.aborted) { setError(errorMessage(failure)); notify({ kind: 'error', message: errorMessage(failure) }) }
    } finally {
      if (installer.current === controller) installer.current = undefined
      if (!controller.signal.aborted) { setPending(false); onPending(false) }
    }
  }
  return createElement('div', { style: { display: 'grid', gap: 12 }, 'data-codingns-avatar-catalog-preview': true },
    createElement('div', { style: { display: 'grid', gap: 10 }, 'data-codingns-avatar-catalog-selection': selected.id },
      createElement('div', { 'data-codingns-avatar-temporary-preview': true, 'aria-busy': previewLoading || pending,
        style: { minHeight: 182, display: 'grid', justifyItems: 'center', alignItems: 'center' } },
        temporary === undefined ? previewLoading || pending
          // 下载与渲染占用同一预览位置，只显示动画，避免出现第二份进度界面。
          ? createElement('div', { style: { position: 'relative', width: 168, height: 182, maxWidth: '100%' } },
            createElement(AssistantAvatarLoading, { progress: { phase: 'resources' }, size: 168, t, animationOnly: true }))
          : createElement('p', { role: 'status', style: { ...helpStyle, textAlign: 'center' } },
            t(error ? 'avatar.temporaryLoadFailed' : 'avatar.temporaryUnavailable'))
          : createElement(AssistantAvatarSlot, { services, model: temporary.model, state: 'idle', surface: 'dialog', size: 168, transient: true, showDiagnostics: false })),
      createElement('p', { style: helpStyle }, t('avatar.catalogPreviewHint')),
      createElement('strong', null, selected.name),
      createElement('p', { style: helpStyle }, selected.description),
      createElement('div', { style: helpStyle }, t('avatar.packageAuthor', { author: selected.author })),
      createElement('div', { style: helpStyle }, t('avatar.packageLicense', { license: selected.license })),
      createElement('p', { style: helpStyle }, selected.remarks),
      createElement('div', { style: helpStyle }, t('avatar.catalogSize', { size: `${(selected.bytes / 1024 / 1024).toFixed(2)} MB`, files: selected.files })),
      createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 13 } },
        createElement('a', { href: selected.repositoryUrl, target: '_blank', rel: 'noopener noreferrer' }, t('avatar.packageSource')),
        createElement('a', { href: selected.licenseUrl, target: '_blank', rel: 'noopener noreferrer' }, t('avatar.catalogLicenseLink')),
        createElement('a', { href: selected.homepage, target: '_blank', rel: 'noopener noreferrer' }, t('avatar.packageHomepage'))),
      selected.format === 'codex-pet' ? null : createElement('p', { style: helpStyle }, t('avatar.live2dDependencyHint')),
      installed ? createElement('span', { style: { color: dshThemeColor.success, fontSize: 13 } }, t('avatar.catalogInstalled')) : null,
      createElement('label', { style: checkStyle },
        createElement('input', { type: 'checkbox', checked: licenseAccepted, disabled: disabled || pending,
          onChange: (event: { currentTarget: { checked: boolean } }) => setLicenseAccepted(event.currentTarget.checked) }), t('avatar.catalogLicenseAgree')),
      createElement('button', { type: 'button', disabled: disabled || pending || previewLoading || !licenseAccepted || full, style: buttonStyle,
        onClick: () => { void install() } }, t('avatar.temporaryUse'))),
    !error ? null : createElement('div', { role: 'alert', style: { color: dshThemeColor.error, fontSize: 13 } }, error))
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
