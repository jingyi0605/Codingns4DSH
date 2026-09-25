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
