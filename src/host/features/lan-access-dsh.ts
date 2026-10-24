import type { FeatureModule } from '../../shared/contracts/feature.js'
import { DEFAULT_LAN_ACCESS_DSH_PWA_SETTINGS, type CodingNsSettings, type LanAccessDshSettings } from '../../shared/contracts/config.js'
import { createLanAccessDshRpcHandler, createNodeLanAccessDshRuntime, FileLanAccessDshLoginStore, LanAccessDshProxy, startLanAccessDsh, type LanAccessDshRuntime } from '../lan-access-dsh.js'
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
      const proxy = new LanAccessDshProxy(runtime, context.services.dshWebAuthenticatedUrl, undefined, context.services.quickAppLanTransport)
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
      const sendPwaNotification = (session: unknown, event: unknown): void => {
        const pwa = settings?.get().lanAccessDsh.pwa
        if (pwa?.enabled !== true || pwa.notifications !== 'push') return
        const payload = createPwaSessionNotification({ session, event, locale: resolveHostPushLocale(context.services.settingsProvider) })
        if (payload === null) return
        void push.sendToAll(payload).catch((error: unknown) => {
          // 单个推送服务故障不能影响 DSH 会话事件处理。
          console.warn('codingns4dsh: PWA 会话通知发送失败', error)
        })
      }
      // 推送订阅由浏览器显式开启；开启后把原生会话完成/等待输入事件转成通知。
      // 事件监听属于局域网功能生命周期，停用模块时随资源一起释放。
      const nativeSessions = context.services.nativeSessions
      if (nativeSessions?.supportsEvents === true) {
        const disposeNotifications = nativeSessions.subscribe({
          onEvent: (session, event) => {
            sendPwaNotification(session, event)
          },
        })
        context.resources.add(disposeNotifications)
      }
      const waitingEventNames = [
        'approval/request',
        'approval/asked',
        'user-questions/request',
        'user_questions/request',
        'user-question/request',
      ] as const
      for (const eventName of waitingEventNames) {
        const dispose = context.services.events?.on(eventName, (...args: unknown[]) => {
          const sessionId = readEventSessionId(args)
          if (sessionId === null) return
          sendPwaNotification({ id: sessionId }, { type: eventName })
        })
        if (typeof dispose === 'function') context.resources.add(dispose as () => void)
      }
      if (settings !== undefined) {
        const autoStart = async (value: CodingNsSettings): Promise<void> => {
          if (!value.lanAccessDsh.autoStart) return
          try {
            await startLanAccessDsh(proxy, { ...toStartInput(value.lanAccessDsh), ...(loginConfig === null ? {} : { login: loginConfig }) }, settings)
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

function readEventSessionId(values: readonly unknown[]): string | null {
  const queue = [...values]
  const seen = new Set<object>()
  while (queue.length > 0) {
    const candidate = queue.shift()
    const record = asRecord(candidate)
    if (record === null || seen.has(record)) continue
    seen.add(record)

    const session = asRecord(record.session) ?? asRecord(asRecord(record.agent)?.session)
    const direct = readSessionId(session) ?? readSessionId(record)
    if (direct !== null && (session !== null || record.header !== undefined || record.sessionId !== undefined || record.session_id !== undefined)) return direct

    for (const key of ['data', 'request', 'interaction', 'payload', 'result', 'session', 'agent']) {
      if (record[key] !== undefined) queue.push(record[key])
    }
  }
  return null
}

function readSessionId(value: unknown): string | null {
  const record = asRecord(value)
  const header = asRecord(record?.header)
  const id = record?.id ?? record?.sessionId ?? record?.session_id ?? header?.id
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function toStartInput(value: LanAccessDshSettings): { listenHost: string; listenPort: number; dshPort?: number } {
  return {
    listenHost: value.listenHost,
    listenPort: value.listenPort,
    ...(value.dshPort > 0 ? { dshPort: value.dshPort } : {}),
  }
}
