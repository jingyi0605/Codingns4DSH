import { createElement, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SettingsSectionOwnerProps,
} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { FeatureRegistry } from '../features/registry.js'
import {
  CODINGNS_MODULES_FIELD,
  isFeatureEnabled,
  isFeatureDshVersionCompatible,
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
  dshSettingsToastStyle,
  dshThemeColor,
} from './theme.js'
import { useCodingNsTranslator } from './locale.js'
import { CODINGNS_VERSION, DSH_COMPATIBILITY, isLegacyDshVersion } from '../shared/contracts/version.js'
import type { CodingNsSettingsSnapshot, CodingNsSettingsStore } from '../dsh-capabilities/settings-store.js'
import type { SettingsNotice } from './features/types.js'

const CODINGNS_GITHUB_URL = 'https://github.com/jingyi0605/Codingns4DSH'

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
  readonly settings: CodingNsSettingsStore<CodingNsSettings>
  readonly registry: FeatureRegistry<CodingNsClientServices, CodingNsClientFeatureModule>
  readonly services: CodingNsClientServices
  /** 当前 Client 进程启动时捕获的重启生效模块状态。 */
  readonly restartStates?: RestartFeatureStates
}

/**
 * DSH 设置页中的 Codingns4DSH 区块。
 *
 * 它只做一件事：遍历注册表中带界面描述的模块并渲染卡片。卡片内容来自模块
 * 自己的 settingsPanel，所以新增模块不会在这里产生分支。
 */
export function CodingNsSettingsSection({ settings, registry, services, restartStates = {} }: CodingNsSectionProps): ReactElement {
  // useSyncExternalStore 要求 subscribe/getSnapshot 保持稳定引用，否则 React
  // 会在每次渲染后重新订阅并强制再次渲染整个设置分区。
  const store = useMemo(() => settingsSnapshotHandle(settings), [settings])
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const t = useCodingNsTranslator(services.locale)
  const [toast, setToast] = useState<SettingsNotice | null>(null)

  useEffect(() => {
    if (toast === null) return
    const timer = globalThis.setTimeout(() => setToast(null), 3200)
    return () => globalThis.clearTimeout(timer)
  }, [toast])

  const notify = (notice: SettingsNotice): void => setToast(notice)

  return createElement(
    'section',
    { style: dshSettingsPageStyle },
    toast === null ? null : createElement('div', {
      role: toast.kind === 'error' ? 'alert' : 'status',
      'aria-live': 'polite',
      style: { ...dshSettingsToastStyle, borderColor: toast.kind === 'error' ? dshThemeColor.error : toast.kind === 'success' ? dshThemeColor.success : dshThemeColor.border },
    }, toast.message),
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
        notify,
      })),
    ),
    createElement('details', { style: { alignSelf: 'center', display: 'flex', flexDirection: 'column-reverse', alignItems: 'center', marginTop: 4, color: dshThemeColor.labelTertiary, textAlign: 'center', fontSize: 12, lineHeight: 1.5 } },
      createElement('summary', { style: { cursor: 'pointer', color: dshThemeColor.labelSecondary, listStylePosition: 'inside' } }, t('settings.version', { version: CODINGNS_VERSION })),
      createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center', maxWidth: 'min(100%, 560px)', marginBottom: 8, padding: '8px 12px', border: `1px solid ${dshThemeColor.border}`, borderRadius: 6, background: dshThemeColor.surfaceSubtle } },
        createElement('div', undefined, t('settings.compatibility', { range: DSH_COMPATIBILITY })),
        createElement('a', { href: CODINGNS_GITHUB_URL, target: '_blank', rel: 'noreferrer', style: { color: dshThemeColor.accent, overflowWrap: 'anywhere' } }, CODINGNS_GITHUB_URL),
      ),
    ),
  )
}

/** 稳定引用包装：设置页只依赖内部 Store 契约，不感知 DSH 侧实现。 */
function settingsSnapshotHandle(settings: CodingNsSettingsStore<CodingNsSettings>): {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => CodingNsSettingsSnapshot<CodingNsSettings>
} {
  return {
    subscribe: (listener) => settings.subscribe(listener),
    getSnapshot: () => settings.getSnapshot(),
  }
}

interface FeatureCardProps {
  readonly entry: CodingNsSettingsModule
  readonly snapshot: CodingNsSettingsSnapshot<CodingNsSettings>
  readonly services: CodingNsClientServices
  readonly restartStates: RestartFeatureStates
  readonly notify: (notice: SettingsNotice) => void
}

/** 通用功能模块卡片：标题栏开关由 descriptor.ui 决定，内容由模块自己提供。 */
function FeatureCard({ entry, snapshot, services, restartStates, notify }: FeatureCardProps): ReactElement {
  const { module, ui } = entry
  const [open, setOpen] = useState(ui.defaultOpen === true)
  const t = useCodingNsTranslator(services.locale)
  const versionCompatible = isFeatureDshVersionCompatible(module.descriptor, services.dshVersion)
  const requestedEnabled = isFeatureEnabled(module.descriptor, snapshot.value)
  const temporarilyDisabled = module.descriptor.disabled === true
  const enabled = !temporarilyDisabled && versionCompatible && requestedEnabled
  const panel = module.settingsPanel
  // 常驻模块不提供关闭入口；设置未就绪或只读时也不允许切换。
  const switchDisabled = temporarilyDisabled || ui.alwaysEnabled === true || !versionCompatible || snapshot.status === 'loading' || !snapshot.writable

  const toggle = (next: boolean): void => {
    if (!versionCompatible) {
      notify({ kind: 'error', message: t('settings.versionBlocked', {
        version: services.dshVersion,
        minimum: module.descriptor.minimumDshVersion ?? t('settings.unknownVersion'),
      }) })
      return
    }
    void services.settings
      .mutate([{ op: 'set', path: [CODINGNS_MODULES_FIELD, module.descriptor.name], value: next }])
      .then((accepted) => {
        if (!accepted) {
          notify({ kind: 'error', message: t('settings.moduleWriteRejected') })
          return
        }
        notify({ kind: 'success', message: t(next ? 'settings.moduleEnabled' : 'settings.moduleDisabled', { label: t(ui.labelKey ?? ui.label) }) })
      })
      .catch((cause: unknown) => {
        notify({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      })
  }

  return createElement(
    'details',
    {
      open,
      onToggle: (event: { currentTarget: { open: boolean } }) => setOpen(event.currentTarget.open),
      style: dshSettingsCardStyle,
    },
    createElement('summary', {
      style: dshSettingsSummaryStyle,
    },
      createElement('span', { style: dshSettingsSummaryTextStyle },
        createElement('span', {
          'aria-hidden': true,
          style: {
            width: 8,
            height: 8,
            flex: '0 0 8px',
            borderRight: `1.5px solid ${dshThemeColor.labelTertiary}`,
            borderBottom: `1.5px solid ${dshThemeColor.labelTertiary}`,
            transform: open ? 'rotate(45deg)' : 'rotate(-45deg)',
            transformOrigin: 'center',
            transition: 'transform 160ms ease',
          },
        }),
        createElement('span', { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
          createElement('span', { style: dshSettingsSummaryLabelStyle }, t(ui.labelKey ?? ui.label)),
          createElement('span', { style: dshSettingsSummaryDescriptionStyle }, t(ui.descriptionKey ?? ui.description)),
        ),
      ),
      createElement(FeatureSwitch, {
        label: t(ui.labelKey ?? ui.label),
        checked: enabled,
        disabled: switchDisabled,
        onChange: toggle,
      }),
    ),
    createElement('div', { style: dshSettingsBodyStyle },
      versionCompatible && ui.legacyFallback === true && isLegacyDshVersion(services.dshVersion)
        ? createElement('div', { role: 'status', style: { marginBottom: 10, color: dshThemeColor.labelSecondary } }, t(ui.legacyFallbackKey ?? 'settings.legacyFallback'))
        : null,
      !versionCompatible
        ? createElement('div', { role: 'alert', style: { marginBottom: 10, color: dshThemeColor.error } }, t('settings.versionBlocked', {
          version: services.dshVersion,
          minimum: module.descriptor.minimumDshVersion ?? t('settings.unknownVersion'),
        }))
        : null,
      temporarilyDisabled
        ? createElement('div', { role: 'status', style: { marginBottom: 10, color: dshThemeColor.labelSecondary } }, t('settings.maintenanceDisabled'))
        : null,
      panel === undefined ? null : createElement(panel, { services, enabled, snapshot, notify }),
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
