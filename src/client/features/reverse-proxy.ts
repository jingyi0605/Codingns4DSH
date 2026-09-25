import { ReverseProxyPanel } from './reverse-proxy-panel.js'
import type { CodingNsClientFeatureModule } from './types.js'
import type { CodingNsRpcClient } from './types.js'
import { startDshH5Bootstrap } from '../dsh-h5-bootstrap.js'
import { LOGIN_PROTECTION_SESSION_EVENT, readLoginProtectionSession } from './login-protection-session.js'
import type { LanAccessDshLoginSettings } from '../../shared/contracts/config.js'
import { CODINGNS_RPC_CHANNEL } from '../../shared/contracts/transport.js'

function isRemoteWebContext(): boolean {
  return (globalThis as typeof globalThis & {
    readonly __DSH_CODINGNS_REMOTE_WEB_CONTEXT__?: boolean
  }).__DSH_CODINGNS_REMOTE_WEB_CONTEXT__ === true
}

/**
 * 中转访问服务模块。
 *
 * 它把 DSH 页面接入 DSH-CodingNS 独立设备隧道。登录和设备列表由 Host RPC 提供，
 * 连接状态和设备选择由设置面板承载；隧道本身在模块启用时建立。
 */
export const reverseProxyFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'reverseProxy',
    version: '0.1.1',
    enabledByDefault: false,
    dependencies: [],
    runtime: 'client',
    ui: {
      label: '中转访问服务',
      description: '通过 DSH-CodingNS 独立设备隧道访问 Host。',
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
  start(context) {
    if (isRemoteWebContext()) {
      // 远程 DSH Web 的外层已经拥有有效 Tunnel；这里只保留设置 UI 和其它
      // 插件贡献，禁止同一页面重新申请票据并建立第二条中继连接。
      return () => {}
    }
    const abort = new AbortController()
    let disposeConnection: (() => Promise<void>) | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    let waitingForLogin = false
    const onLoginProtectionSession = (): void => {
      waitingForLogin = false
      void attempt()
    }
    globalThis.addEventListener(LOGIN_PROTECTION_SESSION_EVENT, onLoginProtectionSession)
    const attempt = async (): Promise<void> => {
      if (stopped || waitingForLogin) return
      try {
        const protection = await readLoginProtectionSettings(context.services.rpc)
        const loginProtectionToken = readLoginProtectionSession()
        if (protection.enabled && protection.scopes.relay && loginProtectionToken === undefined) {
          waitingForLogin = true
          return
        }
        const dispose = await startBrowserRelayConnection(context.services.rpc, abort.signal, loginProtectionToken)
        if (stopped || abort.signal.aborted) { await dispose(); return }
        disposeConnection = dispose
      } catch (error) {
        if (stopped || abort.signal.aborted) return
        console.error('dsh-codingns: 中继连接建立失败，将在稍后重试', error)
        retryTimer = setTimeout(() => { void attempt() }, 5_000)
      }
    }
    void attempt()
    return async () => {
      stopped = true
      globalThis.removeEventListener(LOGIN_PROTECTION_SESSION_EVENT, onLoginProtectionSession)
      abort.abort()
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      await disposeConnection?.()
    }
  },
  settingsPanel: ReverseProxyPanel,
}

/** 浏览器侧真实中继连接；refresh token 和 access token 只经过 Host RPC。 */
export async function startBrowserRelayConnection(rpc: CodingNsRpcClient, signal: AbortSignal, loginProtectionToken?: string): Promise<() => Promise<void>> {
  const bootstrap = await startDshH5Bootstrap({ rpc, signal, ...(loginProtectionToken === undefined ? {} : { loginProtectionToken }) })
  const state = globalThis as typeof globalThis & { __DSH_CODINGNS_RELAY_MODE__?: 'direct' | 'relay' }
  state.__DSH_CODINGNS_RELAY_MODE__ = bootstrap.relayMode
  return async () => {
    if (state.__DSH_CODINGNS_RELAY_MODE__ === bootstrap.relayMode) delete state.__DSH_CODINGNS_RELAY_MODE__
    await bootstrap.dispose()
  }
}

async function readLoginProtectionSettings(rpc: CodingNsRpcClient): Promise<LanAccessDshLoginSettings> {
  let response
  try {
    response = await rpc.call(CODINGNS_RPC_CHANNEL, 'lanAccessDsh/login/get', {})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/HTTP (?:404|405)\b/u.test(message)) throw error
    response = await rpc.call('/api', 'codingns/lanAccessDsh/login/get', {})
  }
  if (!response.ok) throw new Error(response.error.message)
  return response.value as LanAccessDshLoginSettings
}
