import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { HostBindRequest, LoginByEmailRequest } from '../../shared/contracts/auth.js'
import { CodingNsAuthSession } from '../auth-session.js'
import { HttpCodingNsControlApiClient } from '../control-api-client.js'
import { InMemoryCodingNsCredentialStore } from '../credential-store.js'
import { CodingNsRpcError } from '../rpc-table.js'
import type { CodingNsHostServices } from './types.js'

/** 未登录时的稳定快照；Client 首次读取 `auth/snapshot` 会拿到它。 */
const LOGGED_OUT_SNAPSHOT = {
  status: 'logged_out',
  account: null,
  currentDevice: null,
  binding: null,
  expiresAt: null,
  errorCode: null,
}

type AuthAction = (payload: unknown) => unknown | Promise<unknown>

/**
 * 认证模块：登录、凭据、设备查询和 Host 绑定。
 *
 * 它是唯一持有 CodingNsAuthSession 和凭据存储的地方，并以 `auth/*` 命名空间
 * 暴露 RPC。refresh token 只存在于这里，所有响应都不包含它。模块没有界面：
 * 这些设置由「中转访问服务」卡片承载。
 */
export function createAuthFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'auth',
      version: '0.1.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    start(context) {
      const credentials = new InMemoryCodingNsCredentialStore()
      let session: CodingNsAuthSession | null = null
      let sessionBaseUrl: string | null = null

      const ensureSession = async (controlBaseUrl: string): Promise<CodingNsAuthSession> => {
        if (session && sessionBaseUrl === controlBaseUrl) return session
        if (session) await session.logout()
        session = new CodingNsAuthSession(
          new HttpCodingNsControlApiClient({ controlBaseUrl }),
          credentials,
          controlBaseUrl,
        )
        sessionBaseUrl = controlBaseUrl
        return session
      }

      const requireSession = (): CodingNsAuthSession => {
        if (!session) throw new CodingNsRpcError('CODINGNS_RPC_UNAUTHENTICATED', 'CodingNS 尚未登录')
        return session
      }

      const actions: Record<string, AuthAction> = {
        snapshot: () => session?.snapshot() ?? LOGGED_OUT_SNAPSHOT,
        login: async (payload) => {
          const input = parseLogin(payload)
          const target = await ensureSession(input.controlBaseUrl)
          await target.login({ email: input.email, password: input.password })
          return target.snapshot()
        },
        logout: async () => {
          if (session) await session.logout()
          return { status: 'logged_out' }
        },
        devices: () => requireSession().getDevices(),
        bind: (payload) => requireSession().bindHost(parseHostBind(payload)),
        unbind: (payload) => requireSession().unbindHost(parseStringField(payload, 'bindingId')),
      }

      context.resources.add(context.services.rpc.register('auth', (action, payload) => {
        const handler = actions[action]
        if (handler === undefined) {
          throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 CodingNS RPC: auth/${action}`)
        }
        return handler(payload)
      }))

      context.resources.add(async () => {
        await session?.logout()
        session = null
        sessionBaseUrl = null
      })
    },
  }
}

function parseLogin(value: unknown): LoginByEmailRequest & { controlBaseUrl: string } {
  if (!isRecord(value)) throw new TypeError('登录参数必须是对象')
  return {
    controlBaseUrl: requireUrl(value.controlBaseUrl),
    email: requireString(value.email, 'email'),
    password: requireString(value.password, 'password'),
  }
}

function parseHostBind(value: unknown): HostBindRequest {
  if (!isRecord(value)) throw new TypeError('Host 绑定参数必须是对象')
  return {
    hostLabel: requireString(value.hostLabel, 'hostLabel'),
    hostPublicKey: requireString(value.hostPublicKey, 'hostPublicKey'),
    hostFingerprint: requireString(value.hostFingerprint, 'hostFingerprint'),
  }
}

function parseStringField(value: unknown, field: string): string {
  if (!isRecord(value)) throw new TypeError(`${field} 参数必须是对象`)
  return requireString(value[field], field)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} 不能为空`)
  return value.trim()
}

function requireUrl(value: unknown): string {
  const raw = requireString(value, 'controlBaseUrl')
  const parsed = new URL(raw)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new TypeError('controlBaseUrl 必须使用 HTTP(S)')
  return parsed.toString().replace(/\/$/u, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
