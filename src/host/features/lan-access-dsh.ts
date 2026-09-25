import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsSettings, LanAccessDshSettings } from '../../shared/contracts/config.js'
import { createLanAccessDshRpcHandler, createNodeLanAccessDshRuntime, FileLanAccessDshLoginStore, LanAccessDshProxy, type LanAccessDshRuntime } from '../lan-access-dsh.js'
import type { CodingNsHostServices } from './types.js'

/** Host 侧“局域网访问 DSH”模块，只管理一条 DSH Web 监听映射。 */
export function createLanAccessDshFeature(options: { runtime?: LanAccessDshRuntime } = {}): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'lanAccessDsh',
      version: '0.2.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    async start(context) {
      const runtime = options.runtime ?? createNodeLanAccessDshRuntime(context.services.dshWebPort)
      const proxy = new LanAccessDshProxy(runtime)
      const settings = context.services.settings
      const loginStore = new FileLanAccessDshLoginStore()
      const loginConfig = await loginStore.read()
      proxy.setLoginConfig(loginConfig)
      context.resources.add(context.services.rpc.register('lanAccessDsh', createLanAccessDshRpcHandler(proxy, settings, loginStore)))
      if (settings !== undefined) {
        const autoStart = async (value: CodingNsSettings): Promise<void> => {
          if (!value.lanAccessDsh.autoStart) return
          try {
            await proxy.start({ ...toStartInput(value.lanAccessDsh), ...(loginConfig === null ? {} : { login: loginConfig }) })
          } catch (error) {
            // 自动启动失败不能阻断 DSH，其它功能仍应正常可用；用户仍可在卡片中手动重试。
            console.error('dsh-codingns: 局域网访问 DSH 自动启动失败', error)
          }
        }
        await autoStart(settings.get())
      }
      context.resources.add(() => proxy.close())
    },
  }
}

function toStartInput(value: LanAccessDshSettings): { listenHost: string; listenPort: number; dshPort?: number } {
  return {
    listenHost: value.listenHost,
    listenPort: value.listenPort,
    ...(value.dshPort > 0 ? { dshPort: value.dshPort } : {}),
  }
}
