import { DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS } from '../../shared/contracts/config.js'
import { ensureCryptoRandomUUID } from '../lan-access.js'
import { startPwaInstallPrompt, type PwaInstallPromptController } from '../pwa-install-prompt.js'
import { LanAccessPanel } from './lan-access-panel.js'
import type { CodingNsClientFeatureModule } from './types.js'

/**
 * 局域网访问DSH模块。
 *
 * 入口加载时会补齐 `crypto.randomUUID`（见 client/index.ts）；设置面板另外承载
 * 监听转发配置与移动端 PWA 开关。start 是幂等的，重复执行不会覆盖浏览器原生实现。
 *
 * 安装引导条只在设置允许时创建：它读取启动页脚本写入的
 * `globalThis.__CODINGNS_PWA__`，因此 PWA 关闭或回环入口下不会出现任何节点。
 */
export const lanAccessFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'lanAccess',
    version: '0.2.0',
    enabledByDefault: true,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: '局域网访问DSH',
      description: '通过局域网访问 DSH',
      labelKey: 'feature.lanAccess.label',
      descriptionKey: 'feature.lanAccess.description',
      order: 10,
      alwaysEnabled: true,
    },
  },
  start: (context) => {
    ensureCryptoRandomUUID()
    let prompt: PwaInstallPromptController | undefined
    const sync = (): void => {
      const pwa = context.services.settings.getSnapshot().value?.lanAccessDsh.pwa ?? DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS
      if (!pwa.enabled || !pwa.installPrompt) {
        prompt?.dispose()
        prompt = undefined
        return
      }
      if (prompt === undefined) {
        prompt = startPwaInstallPrompt()
        return
      }
      prompt.refresh()
    }
    context.resources.add(context.services.settings.subscribe(sync))
    context.resources.add(() => {
      prompt?.dispose()
      prompt = undefined
    })
    sync()
  },
  settingsPanel: LanAccessPanel,
}
