import { ReverseProxyPanel } from './reverse-proxy-panel.js'
import type { CodingNsClientFeatureModule } from './types.js'

/**
 * 中转访问服务模块。
 *
 * 它把 DSH 页面接入 CodingNS 隧道。登录、设备和 Host 绑定都是这个模块的配置
 * 内容，因此由它的设置面板承载；隧道本身的连接建立在后续阶段接入 start。
 */
export const reverseProxyFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'reverseProxy',
    version: '0.1.0',
    enabledByDefault: false,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: '中转访问服务',
      description: '通过 CodingNS 隧道访问当前 Host。',
      labelKey: 'feature.reverseProxy.label',
      descriptionKey: 'feature.reverseProxy.description',
      order: 20,
      defaultOpen: true,
    },
  },
  /**
   * 隧道连接属于后续阶段，当前模块只提供配置面，因此这里不创建任何资源。
   * 接入连接后，流与订阅必须登记到 context.resources，由停用自动清理。
   */
  start: () => undefined,
  settingsPanel: ReverseProxyPanel,
}
