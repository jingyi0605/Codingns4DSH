import { createElement } from 'react'
import type { ReactElement } from 'react'
import type { CodingNsClientFeatureModule, CodingNsClientServices } from './types.js'
import { codingNsTranslator } from '../locale.js'
import { providerIconUrl } from '../provider-icons.js'
import { createGlobalPanelAdapter, type GlobalPanelIconProps } from '../../dsh-capabilities/client/global-panel-adapter.js'
import { MagpieManagementPage } from './magpie-management-page.js'

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
 * 侧栏入口图标：复用项目内已有的 Magpie 原生图标（`assets/provider-icons/magpie.png`，
 * 由 `provider-icon-assets.ts` 在客户端启动时安装到 `providerIconUrl`），
 * 与页面、模型标记里的 Magpie 标识共用同一份资源，不再自绘字母图形。
 */
function MagpiePanelIcon({ size }: GlobalPanelIconProps): ReactElement {
  const iconUrl = providerIconUrl('magpie')
  if (iconUrl !== undefined) {
    return createElement('img', {
      src: iconUrl,
      alt: '',
      'aria-hidden': true,
      width: size,
      height: size,
      style: { display: 'block', width: size, height: size, objectFit: 'contain' },
    })
  }
  // 图标资源尚未安装（测试或裁剪过的宿主）时用中性占位，不自绘字母冒充品牌。
  return createElement('span', {
    'aria-hidden': true,
    style: { display: 'block', width: size, height: size, borderRadius: Math.round(size / 4), background: 'currentColor', opacity: 0.22 },
  })
}
