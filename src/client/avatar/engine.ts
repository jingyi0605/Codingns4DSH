import { createElement, useEffect, useId, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { ASSISTANT_AVATAR_ENGINE_CONSENT_VERSION, hasAssistantAvatarEngineConsent } from '../../shared/assistant-avatar-engine.js'
import type { AssistantAvatarEngineStatus } from '../../shared/assistant-avatar-engine.js'
import type { AssistantAppearanceSettings } from '../../shared/assistant-avatar.js'
import type { CodingNsClientServices, SettingsNotice } from '../features/types.js'
import { useCodingNsTranslator, type CodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsHelpStyle, dshSettingsPrimaryButtonStyle, dshThemeColor } from '../theme.js'
import { assistantSettingCheckboxStyle } from '../assistant-settings-styles.js'
import type { AssistantAvatarManager } from './manager.js'

export interface AssistantAvatarEngineController {
  readonly status: AssistantAvatarEngineStatus | undefined
  readonly installing: boolean
  readonly cancelled: boolean
  readonly error: string
  readonly consentOpen: boolean
  readonly agreed: boolean
  /** 选择 Live2D 形象时调用：已就绪或安装成功返回 true，需要确认许可或失败返回 false。 */
  ensure(onReady: () => Promise<void> | void): Promise<boolean>
  setAgreed(agreed: boolean): void
  acceptConsent(): Promise<void>
  cancelConsent(): void
  cancelInstall(): void
  retry(): void
}

interface AssistantAvatarEngineOptions {
  readonly services: CodingNsClientServices
  readonly manager: AssistantAvatarManager
  readonly appearance: AssistantAppearanceSettings
  readonly disabled: boolean
  readonly notify?: (notice: SettingsNotice) => void
}

/**
 * 引擎只在用户选择 Live2D 形象时准备：先探测 Host 已就绪的引擎，
 * 未安装则确认许可后自动下载安装；安装失败不改变当前形象。
 */
export function useAssistantAvatarEngine(options: AssistantAvatarEngineOptions): AssistantAvatarEngineController {
  const { services, manager, appearance, disabled, notify } = options
  const t = useCodingNsTranslator(services.locale)
  const [status, setStatus] = useState<AssistantAvatarEngineStatus | undefined>()
  const [installing, setInstalling] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [error, setError] = useState('')
  const [consentOpen, setConsentOpen] = useState(false)
  const [agreed, setAgreed] = useState(false)
  const installer = useRef<AbortController | undefined>()
  const pending = useRef<(() => Promise<void> | void) | undefined>()
  const mounted = useRef(true)
  // 开发模式会重复挂载同一组件；每次挂载都恢复标记，避免卸载后不再更新界面。
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; installer.current?.abort() } }, [])
  useEffect(() => {
    const controller = new AbortController()
    void manager.engineStatus(controller.signal).then((value) => {
      if (!controller.signal.aborted && mounted.current) setStatus(value)
    }).catch(() => undefined)
    return () => controller.abort()
  }, [manager])
  const runInstall = async (onReady: () => Promise<void> | void): Promise<boolean> => {
    if (disabled) return false
    const controller = new AbortController()
    installer.current = controller
    pending.current = onReady
    setInstalling(true); setError(''); setCancelled(false)
    try {
      const next = await manager.installEngine(controller.signal)
      if (controller.signal.aborted) return false
      pending.current = undefined
      setStatus(next)
      await onReady()
      notify?.({ kind: 'success', message: t('avatar.engineInstalled') })
      return true
    } catch (failure) {
      // 取消不是失败：保留原选择与待办，用户可以直接重试。
      if (!controller.signal.aborted && mounted.current) setError(errorMessage(failure))
      return false
    } finally {
      if (installer.current === controller) installer.current = undefined
      if (mounted.current) setInstalling(false)
    }
  }
  const ensure = async (onReady: () => Promise<void> | void): Promise<boolean> => {
    if (disabled || installing) return false
    setError('')
    let current = status
    try {
      current = await manager.engineStatus()
      if (mounted.current) setStatus(current)
    } catch { /* 探测失败仍继续尝试安装，真实错误由安装接口返回。 */ }
    if (current?.installed === true) { await onReady(); return true }
    if (!hasAssistantAvatarEngineConsent(appearance.engineConsent)) {
      pending.current = onReady; setAgreed(false); setConsentOpen(true); return false
    }
    return await runInstall(onReady)
  }
  return {
    status, installing, cancelled, error, consentOpen, agreed, ensure,
    setAgreed: (value: boolean) => { setAgreed(value) },
    acceptConsent: async (): Promise<void> => {
      try {
        await manager.setEngineEnabled(true)
        if (!mounted.current) return
        setConsentOpen(false); setAgreed(false)
        const next = pending.current
        if (next !== undefined) await runInstall(next)
      } catch (failure) { if (mounted.current) setError(errorMessage(failure)) }
    },
    cancelConsent: (): void => { pending.current = undefined; setAgreed(false); setConsentOpen(false) },
    cancelInstall: (): void => { if (installer.current !== undefined) { setCancelled(true); installer.current.abort() } },
    retry: (): void => { const next = pending.current; if (next !== undefined) void runInstall(next) },
  }
}

/** 许可确认使用原生模态；未同意时不产生任何下载或设置写入。 */
export function AssistantAvatarEngineDialog({ controller, t }: {
  readonly controller: AssistantAvatarEngineController; readonly t: CodingNsTranslator
}): ReactElement | null {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  const open = controller.consentOpen
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    return () => { if (dialog?.open) dialog.close(); if (opener?.isConnected) opener.focus() }
  }, [open])
  if (!open) return null
  return createElement('dialog', { ref, 'aria-labelledby': id, 'data-codingns-avatar-engine-dialog': true,
    onCancel: (event: { preventDefault(): void }) => { event.preventDefault(); controller.cancelConsent() },
    onKeyDown: (event: { key: string; preventDefault(): void; stopPropagation(): void }) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controller.cancelConsent() }
    },
    style: { maxWidth: 'min(480px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto',
      boxSizing: 'border-box', padding: 24, borderRadius: 16, margin: 'auto', border: `1px solid ${dshThemeColor.border}`,
      background: dshThemeColor.pageBackground, color: dshThemeColor.labelPrimary, boxShadow: dshThemeColor.subtleShadow } },
    createElement('strong', { id, style: { fontSize: 16 } }, t('avatar.engineTerms', { version: ASSISTANT_AVATAR_ENGINE_CONSENT_VERSION })),
    createElement('div', { style: { display: 'grid', gap: 16, marginTop: 14 } },
      createElement('p', { style: { ...dshSettingsHelpStyle, margin: 0, lineHeight: 1.7 } }, t('avatar.engineTermsContent')),
      createElement('label', { style: assistantSettingCheckboxStyle },
        createElement('input', { type: 'checkbox', checked: controller.agreed,
          onChange: (event: { currentTarget: { checked: boolean } }) => controller.setAgreed(event.currentTarget.checked) }), t('avatar.engineAgree')),
      createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
        createElement('button', { type: 'button', autoFocus: true, style: dshSettingsButtonStyle, onClick: controller.cancelConsent }, t('avatar.cancel')),
        createElement('button', { type: 'button', disabled: !controller.agreed, style: dshSettingsPrimaryButtonStyle,
          onClick: () => { if (controller.agreed) void controller.acceptConsent() } }, t('avatar.engineConfirm')))))
}

/** 安装中显示不确定进度与取消；失败显示原因和重试，不改变当前形象。 */
export function AssistantAvatarEngineProgress({ controller, t }: {
  readonly controller: AssistantAvatarEngineController; readonly t: CodingNsTranslator
}): ReactElement | null {
  if (controller.installing) {
    return createElement('div', { role: 'status', 'data-codingns-avatar-engine-progress': true, style: { display: 'grid', gap: 8 } },
      createElement('span', null, t('avatar.engineInstalling')),
      createElement('progress', { 'aria-label': t('avatar.engineInstalling'), style: { width: '100%' } }),
      createElement('button', { type: 'button', style: { ...dshSettingsButtonStyle, justifySelf: 'start' },
        onClick: controller.cancelInstall }, t('avatar.engineCancel')))
  }
  if (controller.error === '') {
    // 取消后保留待办，用户不必重新选择形象即可重试。
    if (!controller.cancelled) return null
    return createElement('div', { role: 'status', 'data-codingns-avatar-engine-cancelled': true, style: { display: 'grid', gap: 8 } },
      createElement('span', null, t('avatar.engineCancelled')),
      createElement('button', { type: 'button', style: { ...dshSettingsButtonStyle, justifySelf: 'start' },
        onClick: controller.retry }, t('avatar.engineRetry')))
  }
  return createElement('div', { role: 'alert', 'data-codingns-avatar-engine-error': true, style: { display: 'grid', gap: 8, color: dshThemeColor.error, fontSize: 13 } },
    createElement('span', { style: { overflowWrap: 'anywhere' } }, t('avatar.engineInstallFailed', { reason: controller.error })),
    createElement('button', { type: 'button', style: { ...dshSettingsButtonStyle, justifySelf: 'start', color: dshThemeColor.error },
      onClick: controller.retry }, t('avatar.engineRetry')))
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
