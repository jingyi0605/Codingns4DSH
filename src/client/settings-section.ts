import { createElement, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { FeatureRegistry } from '../features/registry.js'
import {
  CODINGNS_MODULES_FIELD,
  isFeatureEnabled,
  type CodingNsSettings,
} from '../shared/contracts/config.js'
import { settingsModules, type CodingNsSettingsModule } from './features/index.js'
import type { CodingNsClientFeatureModule, CodingNsClientServices } from './features/types.js'
import { dshFormRootStyle, dshThemeColor } from './theme.js'

export interface CodingNsSectionProps extends PropsRuntime<'settings.section'> {
  readonly settings: SettingsScope<CodingNsSettings>
  readonly registry: FeatureRegistry<CodingNsClientServices, CodingNsClientFeatureModule>
  readonly services: CodingNsClientServices
}

/**
 * DSH 设置页中的 CodingNS 区块。
 *
 * 它只做一件事：遍历注册表中带界面描述的模块并渲染卡片。卡片内容来自模块
 * 自己的 settingsPanel，所以新增模块不会在这里产生分支。
 */
export function CodingNsSettingsSection({ settings, registry, services }: CodingNsSectionProps): ReactElement {
  const snapshot = useSyncExternalStore(
    (listener) => settings.subscribe(listener),
    () => settings.getSnapshot(),
    () => settings.getSnapshot(),
  )

  return createElement(
    'section',
    { style: { ...dshFormRootStyle, display: 'flex', flexDirection: 'column', gap: 20, padding: 24, maxWidth: 980, width: '100%', boxSizing: 'border-box' } },
    createElement('div', undefined,
      createElement('h2', { style: { margin: 0, fontSize: 20 } }, 'CodingNS 功能模块'),
    ),
    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      settingsModules(registry).map((entry) => createElement(FeatureCard, {
        key: entry.module.descriptor.name,
        entry,
        snapshot,
        services,
      })),
    ),
  )
}

interface FeatureCardProps {
  readonly entry: CodingNsSettingsModule
  readonly snapshot: SettingsScopeSnapshot<CodingNsSettings>
  readonly services: CodingNsClientServices
}

/** 通用功能模块卡片：标题栏开关由 descriptor.ui 决定，内容由模块自己提供。 */
function FeatureCard({ entry, snapshot, services }: FeatureCardProps): ReactElement {
  const { module, ui } = entry
  const [writeError, setWriteError] = useState<string | null>(null)
  const enabled = isFeatureEnabled(module.descriptor, snapshot.value)
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
      style: { border: `1px solid ${dshThemeColor.border}`, borderRadius: 6, overflow: 'hidden' },
    },
    createElement('summary', {
      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px', cursor: 'pointer', fontWeight: 600 },
    },
      createElement('span', undefined, ui.label),
      createElement(FeatureSwitch, {
        label: ui.label,
        checked: enabled,
        disabled: switchDisabled,
        onChange: toggle,
      }),
    ),
    createElement('div', {
      style: { display: 'flex', flexDirection: 'column', gap: 16, padding: 20, borderTop: `1px solid ${dshThemeColor.border}` },
    },
      createElement('p', { style: { margin: 0, fontSize: 13, opacity: 0.65 } }, ui.description),
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
    style: { position: 'relative', display: 'inline-flex', flex: '0 0 auto', width: 42, height: 24, cursor: disabled ? 'not-allowed' : 'pointer' },
    onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  },
    createElement('input', {
      type: 'checkbox',
      role: 'switch',
      'aria-label': `${label}开关`,
      checked,
      disabled,
      onChange: (event: { currentTarget: { checked: boolean } }) => onChange(event.currentTarget.checked),
      style: { position: 'absolute', inset: 0, width: '100%', height: '100%', margin: 0, opacity: 0, cursor: 'inherit', zIndex: 1 },
    }),
    createElement('span', {
      style: { position: 'absolute', inset: 0, borderRadius: 999, background: checked ? dshThemeColor.accent : dshThemeColor.inputBackground, border: `1px solid ${dshThemeColor.border}`, boxSizing: 'border-box', transition: 'background 160ms ease' },
    },
      createElement('span', {
        style: { position: 'absolute', top: 3, left: checked ? 21 : 3, width: 18, height: 18, borderRadius: '50%', background: dshThemeColor.switchThumb, boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)', transition: 'left 160ms ease' },
      }),
    ),
  )
}
