import { createElement, useState } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsClientFeatureModule, CodingNsClientServices, FeaturePanelProps } from './types.js'
import { codingNsTranslator, useCodingNsTranslator } from '../locale.js'
import { useMagpieInstallRequirement, type FeatureRequirement } from '../feature-requirement.js'
import { dshSettingsFieldStyle, dshSettingsNoteStyle, dshSettingsButtonStyle, dshThemeColor } from '../theme.js'
import { uiFontSize } from '../font-scale.js'
import { createGlobalPanelAdapter, type GlobalPanelIconProps } from '../../dsh-capabilities/client/global-panel-adapter.js'
import { MagpieManagementPage } from './magpie-management-page.js'
import { MAGPIE_MARK_PATH } from './magpie-mark.js'

const MAGPIE_PANEL_ID = 'codingns4dsh-magpie-management'

/** Opt-in Magpie dashboard contributed to DSH's native global panel list. */
export const magpieManagementFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'magpieManagement',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: ['cliAdapters'],
    runtime: 'client',
    requires: [{ capability: 'sidebar.global-panel', required: false, fallback: 'disable' }],
    ui: {
      label: 'Magpie management and usage',
      description: 'Enable to add a separate Magpie Management page below Plugins in the global sidebar.',
      labelKey: 'feature.magpieManagement.label',
      descriptionKey: 'feature.magpieManagement.description',
      // 启用前必须在本机找到可运行的 Magpie；设置页据此禁用开关并显示安装原因。
      requirementKey: 'settings.requirement.magpieInstall',
      order: 31,
      defaultOpen: false,
    },
  },
  start(context) {
    const uiContext = context.services.uiContext
    if (uiContext === undefined) return
    const adapter = createGlobalPanelAdapter(uiContext)
    context.resources.add(adapter.register({
      id: MAGPIE_PANEL_ID,
      order: 1,
      label: () => codingNsTranslator(context.services.locale)('magpie.sidebarLabel'),
      icon: MagpiePanelIcon,
      page: MagpieManagementPanel,
      pageProps: { services: context.services },
    }))
  },
  settingsPanel: MagpieInstallPanel,
}

function MagpieManagementPanel({ services, onClose }: {
  readonly services: CodingNsClientServices
  readonly onClose: () => void
}): ReactElement {
  return createElement(MagpieManagementPage, {
    rpc: services.rpc,
    locale: services.locale,
    // 订阅卡的「已用 / 剩余」口径存在 Host 设置里，页面通过同一个存储读写。
    settings: services.settings,
    onClose,
  })
}

/**
 * 侧栏入口图标：内联的喜鹊剪影路径，`fill="currentColor"` 跟随侧栏文字色，
 * 浅色/深色主题下都与上下 DSH 原生图标同色，也不带原图标那块浅色磁贴背景。
 * 纯矢量、不依赖任何图标路由，宿主无需重启就能显示。
 */
function MagpiePanelIcon({ size }: GlobalPanelIconProps): ReactElement {
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 100 100',
    fill: 'currentColor',
    'aria-hidden': true,
  }, createElement('path', { fillRule: 'evenodd', d: MAGPIE_MARK_PATH }))
}

/**
 * Magpie 管理卡片的设置面板。
 *
 * 模块需要本机安装 Magpie 才能工作，因此面板只回答三个问题：是否检测到、
 * 使用的是哪个入口/版本、没检测到时该做什么。检测在 Host 执行，面板不直接
 * 访问文件系统，也不显示 Host 异常原文。
 */
function MagpieInstallPanel({ services, enabled, requirement: cardRequirement }: FeaturePanelProps): ReactElement {
  const t = useCodingNsTranslator(services.locale)
  const ownRequirement = useMagpieInstallRequirement(cardRequirement == null ? services : null)
  const requirement = cardRequirement ?? ownRequirement
  const [showCustom, setShowCustom] = useState(false)
  const [customPath, setCustomPath] = useState('')
  const detection = requirement.detection
  const installed = requirement.state === 'ready'
  const platformKey = t('magpie.install.platform')
  const help = platformKey === 'windows' ? INSTALL_HELP.windows : platformKey === 'linux' ? INSTALL_HELP.linux : INSTALL_HELP.macos
  const statusText = requirement.state === 'checking'
    ? t(requirement.checkingKey)
    : requirement.state === 'ready'
      ? t('magpie.install.detected', { version: detection?.version ?? '--', command: detection?.command ?? '--' })
      : requirement.state === 'missing' && detection?.installed === true && detection.reason !== null
        ? t(`magpie.install.reason.${detection.reason}`, { command: detection.command ?? '--' })
        : requirement.state === 'missing'
          ? t(requirement.requirementKey)
          : t(requirement.failure === 'host-rpc-outdated' ? 'magpie.hostRpcOutdated' : 'magpie.hostRequestFailed')

  return createElement('div', { className: 'codingns-magpie-install-panel', 'data-state': requirement.state },
    createElement('div', {
      role: requirement.state === 'ready' ? 'status' : 'alert',
      style: { ...dshSettingsNoteStyle, color: requirement.state === 'ready' ? dshThemeColor.labelSecondary : dshThemeColor.error },
    }, statusText),
    requirement.state === 'ready'
      ? null
      : createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('strong', { style: { fontSize: uiFontSize(13), color: dshThemeColor.labelPrimary } }, t('magpie.install.title')),
        createElement('span', { style: { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12), lineHeight: 1.5 } }, t(`magpie.install.${help}`)),
        !installed
          ? createElement('span', { style: { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11) } }, t('magpie.install.platform', { platform: platformKey }))
          : null,
        createElement('code', { style: { ...codeStyle, color: dshThemeColor.labelPrimary } }, t('magpie.install.command')),
      ),
    createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
      createElement('button', {
        type: 'button',
        style: dshSettingsButtonStyle,
        disabled: requirement.state === 'checking',
        onClick: () => requirement.recheck({ force: true }),
      }, t(requirement.state === 'checking' ? 'magpie.install.checking' : 'magpie.install.recheck')),
      createElement('button', {
        type: 'button',
        style: dshSettingsButtonStyle,
        'aria-expanded': showCustom,
        onClick: () => setShowCustom(value => !value),
      }, t('magpie.install.customToggle')),
      createElement('button', {
        type: 'button',
        style: dshSettingsButtonStyle,
        disabled: requirement.state === 'checking',
        onClick: () => {
          setCustomPath('')
          requirement.recheck({ resetCommand: true, force: true })
        },
      }, t('magpie.install.customReset')),
      createElement('span', { style: { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11) } },
        t('magpie.install.checkedAt', { time: detection === null ? '--' : formatCheckedAt(detection.checkedAt) })),
    ),
    showCustom
      ? createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        createElement('label', { htmlFor: CUSTOM_PATH_ID, style: { color: dshThemeColor.labelSecondary, fontSize: uiFontSize(12) } }, t('magpie.install.customLabel')),
        createElement('input', {
          id: CUSTOM_PATH_ID,
          type: 'text',
          value: customPath,
          spellCheck: false,
          autoComplete: 'off',
          disabled: requirement.state === 'checking',
          placeholder: t('magpie.install.customPlaceholder'),
          style: dshSettingsFieldStyle,
          onChange: (event: { currentTarget: { value: string } }) => setCustomPath(event.currentTarget.value),
        }),
        createElement('span', { style: { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(11), lineHeight: 1.5 } }, t('magpie.install.customHelp')),
        createElement('button', {
          type: 'button',
          style: { ...dshSettingsButtonStyle, alignSelf: 'flex-start' },
          disabled: customPath.trim() === '' || requirement.state === 'checking',
          onClick: () => requirement.recheck({ commandPath: customPath.trim(), force: true }),
        }, t('magpie.install.customApply')),
      )
      : null,
    enabled === false
      ? createElement('span', { style: { color: dshThemeColor.labelTertiary, fontSize: uiFontSize(12), lineHeight: 1.5 } }, t('magpie.install.disabledNote'))
      : null,
  )
}

const CUSTOM_PATH_ID = 'codingns-magpie-custom-command'

/** 未检测到 Magpie 时的安装指引；按 Host 平台取对应的词典键。 */
const INSTALL_HELP = {
  macos: 'installHelp.macos',
  windows: 'installHelp.windows',
  linux: 'installHelp.linux',
} as const

const codeStyle = {
  display: 'block',
  maxWidth: '100%',
  padding: '7px 9px',
  border: `1px solid ${dshThemeColor.border}`,
  borderRadius: 6,
  background: dshThemeColor.surfaceSubtle,
  fontSize: uiFontSize(12),
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap' as const,
  overflowWrap: 'anywhere' as const,
}

function formatCheckedAt(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toLocaleTimeString() : value
}

/** 面板读取的探测结果类型；导出供设置页与测试共用同一判定。 */
export type { FeatureRequirement }
