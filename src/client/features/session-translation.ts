import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CODINGNS_SESSION_TRANSLATION_FIELD,
  DEFAULT_CODINGNS_SETTINGS,
} from '../../shared/contracts/config.js'
import type { AssistantChatCatalog } from '../../shared/contracts/assistant.js'
import {
  DEFAULT_SESSION_TRANSLATION_SETTINGS,
  normalizeSessionTranslationSettings,
  type SessionTranslationLanguage,
  type SessionTranslationSettings,
} from '../../shared/contracts/session-translation.js'
import type { CodingNsClientFeatureModule, FeaturePanelProps } from './types.js'
import { useCodingNsTranslator } from '../locale.js'
import { callCliRpc } from '../cli-catalog.js'
import { SessionTranslationModelPool } from '../session-translation-model-pool.js'
import { registerSessionTranslationChatUi } from '../session-translation-chat.js'
import { registerSessionTranslationInteractions } from '../session-translation-interactions.js'
import { notifyNativeTranslationDefaultChanged, setNativeTranslationDefaultReader } from '../native-translation-default.js'
import {
  dshFormRootStyle,
  dshSettingsFieldLabelStyle,
  dshSettingsFieldStyle,
  dshSettingsListRowStyle,
  dshSettingsSectionHeaderStyle,
} from '../theme.js'

type SessionTranslationPatch = {
  [Key in keyof SessionTranslationSettings]?: SessionTranslationSettings[Key] | undefined
}

const languageLabelKeys: Readonly<Record<SessionTranslationLanguage, string>> = {
  zh: 'translation.language.zh',
  en: 'translation.language.en',
  fr: 'translation.language.fr',
  de: 'translation.language.de',
  ja: 'translation.language.ja',
}

export const sessionTranslationFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'sessionTranslation',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: ['cliAdapters'],
    runtime: 'client',
    requires: [{ capability: 'conversation.interaction-translation', required: false, fallback: 'degrade' }],
    ui: {
      label: 'Session translation',
      description: 'Translate selected external Agent requests and replies without changing tools, commands, paths, or original history. Control DSH native session translation using the switch in the conversation model selector.',
      labelKey: 'feature.sessionTranslation.label',
      descriptionKey: 'feature.sessionTranslation.description',
      order: 32,
      defaultOpen: false,
    },
  },
  start: (context) => {
    const settings = context.services.settings
    // 菜单订阅默认值及模块启停；已打开的菜单也必须随设置变化更新。
    setNativeTranslationDefaultReader(() => settings.getSnapshot().value?.sessionTranslation?.nativeEnabled === true)
    const removeSettings = settings.subscribe(notifyNativeTranslationDefaultChanged)
    const removeChatUi = registerSessionTranslationChatUi(context.services)
    const removeInteractions = registerSessionTranslationInteractions(context.services)
    return () => {
      removeSettings()
      setNativeTranslationDefaultReader(undefined)
      removeChatUi()
      removeInteractions()
    }
  },
  settingsPanel: SessionTranslationPanel,
}

function SessionTranslationPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const value = normalizeSessionTranslationSettings(snapshot.value?.sessionTranslation ?? DEFAULT_CODINGNS_SETTINGS.sessionTranslation ?? DEFAULT_SESSION_TRANSLATION_SETTINGS)
  const [saving, setSaving] = useState(false)
  const disabled = !enabled || snapshot.status === 'loading' || !snapshot.writable || saving
  const [catalog, setCatalog] = useState<AssistantChatCatalog | null>(null)

  useEffect(() => {
    let active = true
    void callCliRpc<AssistantChatCatalog>(services.rpc, 'translation/models', {}, AbortSignal.timeout(10_000))
      .then((value) => { if (active) setCatalog(value) })
      .catch(() => undefined)
    return () => { active = false }
  }, [services.rpc])

  const save = async (patch: SessionTranslationPatch): Promise<boolean> => {
    if (disabled) return false
    // Omit cleared optional fields, including the legacy single-model selection.
    const next = Object.fromEntries(
      Object.entries({ ...value, ...patch }).filter(([, item]) => item !== undefined),
    )
    setSaving(true)
    try {
      if (!await services.settings.set(CODINGNS_SESSION_TRANSLATION_FIELD, next)) throw new Error(t('translation.saveRejected'))
      notify({ kind: 'success', message: t('translation.saved') })
      return true
    } catch (error) {
      notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      return false
    } finally { setSaving(false) }
  }

  return createElement('div', {
    'aria-disabled': disabled,
    style: { ...dshFormRootStyle, display: 'flex', flexDirection: 'column', gap: 0, opacity: disabled ? 0.55 : 1, pointerEvents: disabled ? 'none' : 'auto' },
  },
  createElement('div', { style: { ...dshSettingsSectionHeaderStyle, marginTop: 0 } },
    createElement('span', { style: dshSettingsFieldLabelStyle }, t('translation.inputTitle')),
  ),
  createElement(Field, { label: t('translation.inputLanguage') },
    createElement('select', {
      value: value.inputLanguage,
      disabled,
      style: dshSettingsFieldStyle,
      onChange: (event: { currentTarget: { value: string } }) => save({ inputLanguage: readInputLanguage(event.currentTarget.value) }),
    }, ...(['zh', 'en', 'fr', 'de', 'ja'] as const).map((language) => createElement('option', { key: language, value: language }, t(languageLabelKeys[language])))),
  ),
  createElement('div', { style: { ...dshSettingsSectionHeaderStyle, marginTop: 12 } },
    createElement('span', { style: dshSettingsFieldLabelStyle }, t('translation.outputTitle')),
  ),
  createElement(Field, { label: t('translation.outputLanguage') },
    createElement('select', {
      value: value.outputLanguage,
      disabled,
      style: dshSettingsFieldStyle,
      onChange: (event: { currentTarget: { value: string } }) => save({ outputLanguage: readOutputLanguage(event.currentTarget.value) }),
    }, ...(['zh', 'en', 'fr', 'de', 'ja'] as const).map((language) => createElement('option', { key: language, value: language }, t(languageLabelKeys[language])))),
  ),
  createElement('div', { style: { ...dshSettingsSectionHeaderStyle, marginTop: 12 } },
    createElement('span', { style: dshSettingsFieldLabelStyle }, t('translation.modelTitle')),
  ),
  createElement(SessionTranslationModelPool, { value, catalog, disabled, pending: saving, t,
    onChange: (models) => save({ translationModels: models, translationModel: undefined }),
  }),
  )
}

function Field({ label, children }: { readonly label: string; readonly children?: ReactElement }): ReactElement {
  return createElement('label', { style: { ...dshSettingsListRowStyle, alignItems: 'flex-start', flexDirection: 'column', gap: 6 } },
    createElement('span', { style: dshSettingsFieldLabelStyle }, label), children ?? null,
  )
}

function readInputLanguage(value: string): SessionTranslationSettings['inputLanguage'] {
  return value === 'zh' || value === 'fr' || value === 'de' || value === 'ja' ? value : 'en'
}

function readOutputLanguage(value: string): SessionTranslationLanguage {
  return value === 'en' || value === 'fr' || value === 'de' || value === 'ja' ? value : 'zh'
}
