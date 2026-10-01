import type { FeatureModule } from '../../shared/contracts/feature.js'
import { DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS, type CodingNsSettings, type LanAccessDshSettings } from '../../shared/contracts/config.js'
import { createLanAccessDshRpcHandler, createNodeLanAccessDshRuntime, FileLanAccessDshLoginStore, LanAccessDshProxy, type LanAccessDshRuntime } from '../lan-access-dsh.js'
import { createLanAccessDshPwaProvider, PwaPushService } from '../modules/pwa/index.js'
import { createPwaSessionNotification } from '../modules/pwa/pwa-session-notifications.js'
import { resolveHostPushLocale } from '../browser-text.js'
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
      const proxy = new LanAccessDshProxy(runtime, context.services.dshWebAuthenticatedUrl)
      const settings = context.services.settings
      // PWA 资产不缓存字节之外的任何状态：设置变化通过 provider 的键检测即时生效。
      proxy.setPwaProvider(createLanAccessDshPwaProvider({
        readSettings: () => settings?.get().lanAccessDsh.pwa ?? DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS,
      }))
      const loginStore = new FileLanAccessDshLoginStore()
      const loginConfig = await loginStore.read()
      proxy.setLoginConfig(loginConfig)
      // 推送只保存订阅与 VAPID 私钥；是否真的订阅由浏览器侧在用户开启时决定。
      const push = new PwaPushService()
      context.resources.add(context.services.rpc.register('lanAccessDsh', createLanAccessDshRpcHandler(proxy, settings, loginStore, {
        push,
        resolveLocale: () => resolveHostPushLocale(context.services.settingsProvider),
      })))
      // 推送订阅由浏览器显式开启；开启后把原生会话完成/等待输入事件转成通知。
      // 事件监听属于局域网功能生命周期，停用模块时随资源一起释放。
      const nativeSessions = context.services.nativeSessions
      if (nativeSessions?.supportsEvents === true) {
        const disposeNotifications = nativeSessions.subscribe({
          onEvent: (session, event) => {
            const pwa = settings?.get().lanAccessDsh.pwa
            if (pwa?.enabled !== true || pwa.notifications !== 'push') return
            const payload = createPwaSessionNotification({ session, event, locale: resolveHostPushLocale(context.services.settingsProvider) })
            if (payload === null) return
            void push.sendToAll(payload).catch((error: unknown) => {
              // 单个推送服务故障不能影响 DSH 会话事件处理。
              console.warn('codingns4dsh: PWA 会话通知发送失败', error)
            })
          },
        })
        context.resources.add(disposeNotifications)
      }
      if (settings !== undefined) {
        const autoStart = async (value: CodingNsSettings): Promise<void> => {
          if (!value.lanAccessDsh.autoStart) return
          try {
            await proxy.start({ ...toStartInput(value.lanAccessDsh), ...(loginConfig === null ? {} : { login: loginConfig }) })
          } catch (error) {
            // 自动启动失败不能阻断 DSH，其它功能仍应正常可用；用户仍可在卡片中手动重试。
            console.error('codingns4dsh: 局域网访问 DSH 自动启动失败', error)
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
