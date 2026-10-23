import { createElement } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsClientFeatureModule, CodingNsClientServices } from './types.js'
import { codingNsTranslator } from '../locale.js'
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
}

function MagpieManagementPanel({ services, onClose }: {
  readonly services: CodingNsClientServices
  readonly onClose: () => void
}): ReactElement {
  return createElement(MagpieManagementPage, {
    rpc: services.rpc,
    locale: services.locale,
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
