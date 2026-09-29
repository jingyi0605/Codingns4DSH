import type { LoginProtectionScopes } from './config.js'

/** “局域网访问 DSH”唯一一条监听配置。 */
export interface LanAccessDshConfig {
  /** 监听地址：本机网卡地址，或 0.0.0.0 监听所有 IPv4 网卡。 */
  listenHost: string
  /** 局域网访问入口端口，默认 13080；填 0 时由系统分配。 */
  listenPort: number
  /** 当前 DSH Web 的本地端口。 */
  dshPort: number
  /** 可选的 Host 侧登录保护；凭据不会进入此配置快照。 */
  login?: LanAccessDshLoginConfig
}

export interface LanAccessDshLoginConfig {
  enabled: boolean
  username: string
  passwordHash: string
  passwordSalt: string
  timeoutSeconds: number
  scopes: LoginProtectionScopes
}

export type LanAccessDshState = 'stopped' | 'starting' | 'listening' | 'error'

/** 局域网访问 DSH 的运行快照。 */
export interface LanAccessDshSnapshot extends Omit<LanAccessDshConfig, 'login'> {
  state: LanAccessDshState
  actualListenPort: number | null
  detectedDshPorts: readonly number[]
  error: string | null
  loginEnabled: boolean
}

/**
 * 局域网入口 PWA 资产的就绪状态。
 *
 * 只描述代理侧的“能不能提供”，浏览器侧的实际注册状态由页面里的
 * `__CODINGNS_PWA__` 提供；两者都不包含任何凭据。
 */
export interface LanAccessDshPwaStatus {
  /** 监听是否正在运行；未运行时资产请求不会到达代理。 */
  readonly listening: boolean
  /** 是否由代理合成 manifest（覆盖上游）。 */
  readonly manifest: boolean
  /** 是否合成并允许注册 Service Worker。 */
  readonly serviceWorker: boolean
  /** manifest 标记值；客户端据此确认资产来自本插件。 */
  readonly marker: string | null
  /** 可用的图标路径。 */
  readonly assetPaths: readonly string[]
  /** 合成资产的对外路径。 */
  readonly paths: {
    readonly manifest: string
    readonly serviceWorker: string
  }
}
