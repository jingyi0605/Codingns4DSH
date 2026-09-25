import { ensureCryptoRandomUUID } from '../lan-access.js'
import { LanAccessPanel } from './lan-access-panel.js'
import type { CodingNsClientFeatureModule } from './types.js'

/**
 * 局域网访问DSH模块。
 *
 * 入口加载时会补齐 `crypto.randomUUID`（见 client/index.ts）；设置面板另外承载
 * 监听转发配置。它的 start 是幂等的，重复执行不会覆盖浏览器原生实现。
 */
export const lanAccessFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'lanAccess',
    version: '0.1.1',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: '局域网访问DSH',
      description: '通过局域网 IP 访问 DSH，自动补齐 crypto.randomUUID，并将监听端口转发到当前 DSH Web。',
      labelKey: 'feature.lanAccess.label',
      descriptionKey: 'feature.lanAccess.description',
      order: 10,
      alwaysEnabled: true,
    },
  },
  start: () => {
    ensureCryptoRandomUUID()
  },
  settingsPanel: LanAccessPanel,
}
