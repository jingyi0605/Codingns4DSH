import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { CODINGNS_ASSISTANT_FIELD, DEFAULT_ASSISTANT_SETTINGS, DEFAULT_ASSISTANT_VOICE_SETTINGS } from '../../shared/contracts/config.js'
import { readNativeWorkspaceListStore, readNativeWorkspaceSnapshot, type NativeWorkspaceRecord } from '../native-workspace-store.js'
import { useCodingNsTranslator } from '../locale.js'
import type { FeaturePanelProps } from './types.js'
import { dshFormRootStyle, dshSettingsButtonStyle, dshSettingsHelpStyle, dshSettingsListRowStyle, dshThemeColor } from '../theme.js'
import { getGlobalVoiceAdapter } from '../global-voice-runtime-registry.js'
import { VoiceInitializationDialog } from './voice-initialization-dialog.js'
import { findAssistantVoiceModel } from '../../shared/voice-models.js'

/** 全局智能助理范围设置；默认空范围，工作区必须由用户逐个勾选。 */
export function AssistantPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const [workspaces, setWorkspaces] = useState<readonly NativeWorkspaceRecord[]>([])
  const [inputDevices, setInputDevices] = useState<readonly { readonly deviceId: string; readonly label: string }[]>([])
  const [inputDeviceId, setInputDeviceId] = useState('')
  const [outputDevices, setOutputDevices] = useState<readonly { readonly deviceId: string; readonly label: string }[]>([])
  const [outputDeviceId, setOutputDeviceId] = useState('')
  const [outputDeviceSupported, setOutputDeviceSupported] = useState(false)
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false)
  const value = snapshot.value?.assistant ?? DEFAULT_ASSISTANT_SETTINGS
  const voice = value.voice ?? DEFAULT_ASSISTANT_VOICE_SETTINGS
  const voiceModel = findAssistantVoiceModel(voice.modelId ?? '')
  const disabled = !enabled || snapshot.status === 'loading' || !snapshot.writable

  useEffect(() => {
    const store = readNativeWorkspaceListStore(services.uiContext)
    const refresh = (): void => setWorkspaces(readNativeWorkspaceSnapshot(services.uiContext)?.items ?? [])
    refresh()
    return store?.subscribe(refresh)
  }, [services.uiContext])

  useEffect(() => {
    const adapter = getGlobalVoiceAdapter(services)
    if (adapter === undefined) return undefined
    let disposed = false
    const refresh = (): void => {
      void adapter.enumerateInputDevices().then((devices) => {
        if (disposed) return
        setInputDevices(devices.map(({ deviceId, label }) => ({ deviceId, label })))
        setInputDeviceId(adapter.inputDeviceId ?? '')
      }).catch(() => { if (!disposed) setInputDevices([]) })
      setOutputDeviceSupported(adapter.outputDeviceSupported)
      void adapter.enumerateOutputDevices().then((devices) => {
        if (disposed) return
        setOutputDevices(devices.map(({ deviceId, label }) => ({ deviceId, label })))
        setOutputDeviceId(adapter.outputDeviceId ?? '')
      }).catch(() => { if (!disposed) setOutputDevices([]) })
    }
    refresh()
    const mediaDevices = globalThis.navigator?.mediaDevices
    const onChange = (): void => refresh()
    mediaDevices?.addEventListener?.('devicechange', onChange)
    return () => { disposed = true; mediaDevices?.removeEventListener?.('devicechange', onChange) }
  }, [services])

  const chooseInputDevice = (deviceId: string): void => {
    const adapter = getGlobalVoiceAdapter(services)
    if (adapter === undefined) return
    void adapter.selectInputDevice(deviceId).then(() => {
      setInputDeviceId(deviceId)
      notify({ kind: 'success', message: t('voice.microphoneUpdated') })
    }).catch((error: unknown) => notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
  }

  const chooseOutputDevice = (deviceId: string): void => {
    const adapter = getGlobalVoiceAdapter(services)
    if (adapter === undefined) return
    void adapter.selectOutputDevice(deviceId).then(() => {
      setOutputDeviceId(deviceId)
      notify({ kind: 'success', message: t('voice.outputUpdated') })
    }).catch((error: unknown) => notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
  }

  const update = (workspaceId: string, checked: boolean): void => {
    const current = new Set(value.managedWorkspaceIds)
    if (checked) current.add(workspaceId)
    else current.delete(workspaceId)
    void services.settings.mutate([{
      op: 'set',
      path: [CODINGNS_ASSISTANT_FIELD, 'managedWorkspaceIds'],
      value: [...current],
    }]).then((accepted) => {
      if (!accepted) notify({ kind: 'error', message: t('settings.moduleWriteRejected') })
      else notify({ kind: 'success', message: t('assistant.saved') })
    }).catch((error: unknown) => notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
  }

  return createElement('div', {
    'aria-disabled': disabled,
    style: { ...dshFormRootStyle, display: 'flex', flexDirection: 'column', gap: 12, opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? 'none' : 'auto' },
  },
    createElement('p', { style: dshSettingsHelpStyle }, t('assistant.scopeDescription')),
    createElement('div', { style: dshSettingsListRowStyle },
      createElement('span', { style: { minWidth: 0, flex: '1 1 auto' } },
        createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, t('voice.setup.title')),
        createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, voice.initialized && voice.provider === 'sherpa-onnx'
          ? voiceModel?.label ?? t('voice.setup.status.sherpa')
          : t('voice.setup.status.uninitialized')),
      ),
      createElement('button', {
        type: 'button',
        disabled,
        onClick: () => setVoiceSetupOpen(true),
        style: { ...dshSettingsButtonStyle, flex: '0 0 auto', whiteSpace: 'nowrap' },
      }, t('voice.setup.reconfigure')),
    ),
    inputDevices.length === 0 ? null : createElement('label', { style: { ...dshSettingsListRowStyle, alignItems: 'center' } },
      createElement('span', { style: { minWidth: 0 } }, t('voice.inputDevice')),
      createElement('select', {
        value: inputDeviceId,
        disabled,
        onChange: (event: { currentTarget: { value: string } }) => chooseInputDevice(event.currentTarget.value),
        style: { maxWidth: 220, minWidth: 0, flex: '0 1 220px' },
      },
        createElement('option', { value: '' }, t('voice.defaultMicrophone')),
        ...inputDevices.map((device) => createElement('option', { key: device.deviceId, value: device.deviceId }, device.label || t('voice.unnamedMicrophone'))),
      ),
    ),
    !outputDeviceSupported ? null : createElement('label', { style: { ...dshSettingsListRowStyle, alignItems: 'center' } },
      createElement('span', { style: { minWidth: 0 } }, t('voice.outputDevice')),
      outputDevices.length === 0
        ? createElement('span', { style: dshSettingsHelpStyle }, t('voice.defaultOutput'))
        : createElement('select', {
          value: outputDeviceId,
          disabled,
          onChange: (event: { currentTarget: { value: string } }) => chooseOutputDevice(event.currentTarget.value),
          style: { maxWidth: 220, minWidth: 0, flex: '0 1 220px' },
        },
          createElement('option', { value: '' }, t('voice.defaultOutput')),
          ...outputDevices.map((device) => createElement('option', { key: device.deviceId, value: device.deviceId }, device.label || t('voice.unnamedOutput'))),
        ),
    ),
    workspaces.length === 0
      ? createElement('div', { role: 'status', style: dshSettingsHelpStyle }, t('assistant.noWorkspaces'))
      : workspaces.map((workspace) => createElement('label', { key: workspace.workspaceId, style: dshSettingsListRowStyle },
        createElement('span', { style: { minWidth: 0 } },
          createElement('strong', { style: { display: 'block', fontSize: 13, lineHeight: 1.4 } }, workspace.title),
          workspace.path === undefined ? null : createElement('span', { style: { display: 'block', marginTop: 3, ...dshSettingsHelpStyle } }, workspace.path),
        ),
        createElement('input', {
          type: 'checkbox', role: 'switch', 'aria-label': workspace.title,
          checked: value.managedWorkspaceIds.includes(workspace.workspaceId), disabled,
          onChange: (event: { currentTarget: { checked: boolean } }) => update(workspace.workspaceId, event.currentTarget.checked),
          style: { flex: '0 0 auto', accentColor: dshThemeColor.accent },
        }),
      )),
    voiceSetupOpen ? createElement(VoiceInitializationDialog, {
      services,
      value: voice,
      onClose: () => setVoiceSetupOpen(false),
    }) : null,
  )
}
