import { createElement, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SettingsScope,
  SettingsScopeSnapshot,
  SettingsSectionOwnerProps,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { FeatureRegistry } from '../features/registry.js'
import {
  CODINGNS_MODULES_FIELD,
  isFeatureEnabled,
  type RestartFeatureStates,
  type CodingNsSettings,
} from '../shared/contracts/config.js'
import { settingsModules, type CodingNsSettingsModule } from './features/index.js'
import type { CodingNsClientFeatureModule, CodingNsClientServices } from './features/types.js'
import {
  dshSettingsBodyStyle,
  dshSettingsCardStyle,
  dshSettingsHeaderStyle,
  dshSettingsPageStyle,
  dshSettingsSubtitleStyle,
  dshSettingsSummaryDescriptionStyle,
  dshSettingsSummaryLabelStyle,
  dshSettingsSummaryStyle,
  dshSettingsSummaryTextStyle,
  dshSettingsTitleStyle,
  dshThemeColor,
} from './theme.js'
import { useCodingNsTranslator } from './locale.js'

// pnpm 会为不同 peer 上下文保留独立的 ui-slots 类型实例；插件在自己实际使用的
// 根实例上重申公开契约，避免依赖声明合并偶然穿过依赖副本。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: SettingsSectionOwnerProps
    }
  }
}

export interface CodingNsSectionProps extends PropsRuntime<'settings.section'> {
  readonly settings: SettingsScope<CodingNsSettings>
  readonly registry: FeatureRegistry<CodingNsClientServices, CodingNsClientFeatureModule>
  readonly services: CodingNsClientServices
  /** 当前 Client 进程启动时捕获的重启生效模块状态。 */
  readonly restartStates?: RestartFeatureStates
}

/**
 * DSH 设置页中的 CodingNS 区块。
 *
 * 它只做一件事：遍历注册表中带界面描述的模块并渲染卡片。卡片内容来自模块
 * 自己的 settingsPanel，所以新增模块不会在这里产生分支。
 */
export function CodingNsSettingsSection({ settings, registry, services, restartStates = {} }: CodingNsSectionProps): ReactElement {
  const snapshot = useSyncExternalStore(
    (listener) => settings.subscribe(listener),
    () => settings.getSnapshot(),
    () => settings.getSnapshot(),
  )
  const t = useCodingNsTranslator(services.locale)

  return createElement(
    'section',
    { style: dshSettingsPageStyle },
    createElement('header', { style: dshSettingsHeaderStyle },
      createElement('h2', { style: dshSettingsTitleStyle }, t('settings.title')),
      createElement('p', { style: dshSettingsSubtitleStyle }, t('settings.subtitle')),
    ),
    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      settingsModules(registry).map((entry) => createElement(FeatureCard, {
        key: entry.module.descriptor.name,
        entry,
        snapshot,
        services,
        restartStates,
      })),
    ),
  )
}

interface FeatureCardProps {
  readonly entry: CodingNsSettingsModule
  readonly snapshot: SettingsScopeSnapshot<CodingNsSettings>
  readonly services: CodingNsClientServices
  readonly restartStates: RestartFeatureStates
}

/** 通用功能模块卡片：标题栏开关由 descriptor.ui 决定，内容由模块自己提供。 */
function FeatureCard({ entry, snapshot, services, restartStates }: FeatureCardProps): ReactElement {
  const { module, ui } = entry
  const t = useCodingNsTranslator(services.locale)
  const [writeError, setWriteError] = useState<string | null>(null)
  const enabled = isFeatureEnabled(module.descriptor, snapshot.value)
  const effectiveEnabled = module.descriptor.activation === 'restart'
    ? restartStates[module.descriptor.name] ?? module.descriptor.enabledByDefault
    : enabled
  const panel = module.settingsPanel
  // 常驻模块不提供关闭入口；设置未就绪或只读时也不允许切换。
  const switchDisabled = ui.alwaysEnabled === true || snapshot.status === 'loading' || !snapshot.writable

  const toggle = (next: boolean): void => {
    setWriteError(null)
    void services.settings
      .mutate([{ op: 'set', path: [CODINGNS_MODULES_FIELD, module.descriptor.name], value: next }])
      .catch((cause: unknown) => {
        setWriteError(cause instanceof Error ? cause.message : String(cause))
      })
  }

  return createElement(
    'details',
    {
      defaultOpen: ui.defaultOpen === true,
      style: dshSettingsCardStyle,
    },
    createElement('summary', {
      style: dshSettingsSummaryStyle,
    },
      createElement('span', { style: dshSettingsSummaryTextStyle },
        createElement('span', { style: dshSettingsSummaryLabelStyle }, t(ui.labelKey ?? ui.label)),
        createElement('span', { style: dshSettingsSummaryDescriptionStyle }, t(ui.descriptionKey ?? ui.description)),
      ),
      createElement(FeatureSwitch, {
        label: t(ui.labelKey ?? ui.label),
        checked: enabled,
        disabled: switchDisabled,
        onChange: toggle,
      }),
    ),
    createElement('div', { style: dshSettingsBodyStyle },
      module.descriptor.activation !== 'restart' ? null : createElement(
        'div',
        { role: 'status', style: { display: 'flex', flexDirection: 'column', gap: 4, padding: 10, border: `1px solid ${dshThemeColor.border}`, borderRadius: 6, fontSize: 13 } },
        createElement('span', undefined, t('settings.restartTarget', { state: enabled ? t('settings.enabled') : t('settings.disabled') })),
        effectiveEnabled === enabled
          ? createElement('span', undefined, t('settings.runtimeReported'))
          : createElement('strong', undefined, t('settings.restartRequired')),
      ),
      panel === undefined ? null : createElement(panel, { services, enabled, snapshot }),
      writeError === null ? null : createElement('div', { role: 'alert', style: { color: dshThemeColor.error } }, writeError),
    ),
  )
}

interface FeatureSwitchProps {
  readonly label: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (next: boolean) => void
}

/** 标题栏开关：真实 checkbox 语义，点击不会连带折叠卡片。 */
function FeatureSwitch({ label, checked, disabled, onChange }: FeatureSwitchProps): ReactElement {
  return createElement('label', {
    style: { position: 'relative', display: 'inline-flex', flex: '0 0 auto', width: 44, height: 24, opacity: disabled ? 0.55 : 1, cursor: disabled ? 'not-allowed' : 'pointer' },
    onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  },
    createElement('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': label,
      checked,
      disabled,
      onChange: (event: { currentTarget: { checked: boolean } }) => onChange(event.currentTarget.checked),
      style: { position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, opacity: 0, cursor: 'inherit', zIndex: 1 },
    }),
    createElement('span', {
      style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', padding: 2, borderRadius: 999, background: checked ? dshThemeColor.accent : dshThemeColor.surfaceSubtle, border: `1px solid ${dshThemeColor.border}`, boxSizing: 'border-box', transition: 'background 160ms ease' },
    },
      createElement('span', {
        style: { width: 18, height: 18, flex: '0 0 18px', borderRadius: '50%', background: dshThemeColor.switchThumb, boxShadow: dshThemeColor.subtleShadow, transform: `translateX(${checked ? 20 : 0}px)`, transition: 'transform 160ms ease' },
      }),
    ),
  )
}
