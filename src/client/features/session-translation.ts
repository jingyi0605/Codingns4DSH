import { createElement, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  CODINGNS_SESSION_TRANSLATION_FIELD,
  DEFAULT_CODINGNS_SETTINGS,
} from '../../shared/contracts/config.js'
import type { AssistantChatCatalog } from '../../shared/contracts/assistant.js'
import {
  DEFAULT_SESSION_TRANSLATION_SETTINGS,
  type SessionTranslationLanguage,
  type SessionTranslationModel,
  type SessionTranslationSettings,
} from '../../shared/contracts/session-translation.js'
import type { CodingNsClientFeatureModule, FeaturePanelProps } from './types.js'
import { useCodingNsTranslator } from '../locale.js'
import { callCliRpc } from '../cli-catalog.js'
import { registerSessionTranslationChatUi } from '../session-translation-chat.js'
import {
  dshFormRootStyle,
  dshSettingsFieldLabelStyle,
  dshSettingsFieldStyle,
  dshSettingsHelpStyle,
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
    ui: {
      label: 'Session translation',
      description: 'Translate selected external Agent requests and replies without changing tools, commands, paths, or original history.',
      labelKey: 'feature.sessionTranslation.label',
      descriptionKey: 'feature.sessionTranslation.description',
      order: 32,
      defaultOpen: false,
    },
  },
  start: (context) => {
    return registerSessionTranslationChatUi(context.services)
  },
  settingsPanel: SessionTranslationPanel,
}

function SessionTranslationPanel({ services, enabled, snapshot, notify }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const value: SessionTranslationSettings = snapshot.value?.sessionTranslation ?? DEFAULT_CODINGNS_SETTINGS.sessionTranslation ?? DEFAULT_SESSION_TRANSLATION_SETTINGS
  const disabled = !enabled || snapshot.status === 'loading' || !snapshot.writable
  const [catalog, setCatalog] = useState<AssistantChatCatalog | null>(null)

  useEffect(() => {
    let active = true
    void callCliRpc<AssistantChatCatalog>(services.rpc, 'translation/models', {}, AbortSignal.timeout(10_000))
      .then((value) => { if (active) setCatalog(value) })
      .catch(() => undefined)
    return () => { active = false }
  }, [services.rpc])

  const save = (patch: SessionTranslationPatch): void => {
    // exactOptionalPropertyTypes 下不能把 undefined 作为可选字段显式写入设置；
    // 选择“跟随默认模型”时直接省略 translationModel，交给 schema 的缺省语义处理。
    const next = Object.fromEntries(
      Object.entries({ ...value, ...patch }).filter(([, item]) => item !== undefined),
    )
    void services.settings.set(CODINGNS_SESSION_TRANSLATION_FIELD, next)
      .then((written) => {
        if (!written) throw new Error(t('translation.saveRejected'))
        notify({ kind: 'success', message: t('translation.saved') })
      })
      .catch((error: unknown) => notify({ kind: 'error', message: error instanceof Error ? error.message : String(error) }))
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
    }, ...(['en', 'fr', 'de', 'ja'] as const).map((language) => createElement('option', { key: language, value: language }, t(languageLabelKeys[language])))),
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
  createElement(ModelField, { value, catalog, disabled, t, onChange: (model) => save({ translationModel: model }) }),
  )
}

function Field({ label, children }: { readonly label: string; readonly children?: ReactElement }): ReactElement {
  return createElement('label', { style: { ...dshSettingsListRowStyle, alignItems: 'flex-start', flexDirection: 'column', gap: 6 } },
    createElement('span', { style: dshSettingsFieldLabelStyle }, label), children ?? null,
  )
}

function ModelField({ value, catalog, disabled, t, onChange }: {
  readonly value: SessionTranslationSettings
  readonly catalog: AssistantChatCatalog | null
  readonly disabled: boolean
  readonly t: ReturnType<typeof useCodingNsTranslator>
  readonly onChange: (model: SessionTranslationModel | undefined) => void
}): ReactElement {
  const selectedKey = value.translationModel === undefined ? '' : JSON.stringify([value.translationModel.provider, value.translationModel.model])
  const models = catalog?.models ?? []
  const hasSelected = selectedKey !== '' && models.some((model) => JSON.stringify([model.provider, model.model]) === selectedKey)
  return createElement('div', { style: { width: '100%', display: 'grid', gap: 6 } },
    createElement('select', {
      value: selectedKey,
      disabled,
      style: dshSettingsFieldStyle,
      onChange: (event: { currentTarget: { value: string } }) => onChange(readTranslationModel(event.currentTarget.value)),
    },
      createElement('option', { value: '' }, t('translation.modelFollowDefault')),
      !hasSelected && selectedKey !== '' && createElement('option', { value: selectedKey }, t('translation.modelUnavailable')),
      ...models.map((model) => createElement('option', { key: JSON.stringify([model.provider, model.model]), value: JSON.stringify([model.provider, model.model]) },
        `${isOfficialProvider(model.provider) ? t('translation.modelOfficial') : t('translation.modelThirdParty')} · ${model.label}`,
      )),
    ),
    catalog === null
      ? createElement('span', { style: dshSettingsHelpStyle }, t('translation.modelLoading'))
      : models.length === 0
        ? createElement('span', { style: dshSettingsHelpStyle }, t('translation.modelEmpty'))
        : createElement('span', { style: dshSettingsHelpStyle }, t('translation.modelHelp')),
  )
}

function readTranslationModel(value: string): SessionTranslationModel | undefined {
  if (value === '') return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' || parsed[0].trim() === '' || parsed[1].trim() === '') return undefined
    return { provider: parsed[0], model: parsed[1] }
  } catch { return undefined }
}

function isOfficialProvider(provider: string): boolean {
  return /^(?:deepseek(?:-official)?|official-deepseek)$/iu.test(provider.trim())
}

function readInputLanguage(value: string): SessionTranslationSettings['inputLanguage'] {
  return value === 'fr' || value === 'de' || value === 'ja' ? value : 'en'
}

function readOutputLanguage(value: string): SessionTranslationLanguage {
  return value === 'en' || value === 'fr' || value === 'de' || value === 'ja' ? value : 'zh'
}
