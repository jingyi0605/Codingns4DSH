import type { FeatureModule } from '../../shared/contracts/feature.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HostBindRequest, LoginByEmailRequest } from '../../shared/contracts/auth.js'
import { CodingNsAuthSession } from '../auth-session.js'
import { HttpCodingNsControlApiClient } from '../control-api-client.js'
import { FileCodingNsCredentialStore, FileDshDeviceCredentialStore } from '../credential-store.js'
import { startDshHostDeviceRuntime, type DshHostDeviceRuntime } from '../dsh-device-runtime.js'
import type { DshRelayTicketRequest } from '../../shared/contracts/dsh-device.js'
import { CodingNsRpcError } from '../rpc-table.js'
import type { CodingNsHostServices } from './types.js'
import { createDshRpcGatewayFeature } from '../dsh-gateway-feature.js'
import { createLocalDshWebRuntimeProvider, createRemoteWebRuntimeFeature } from '../remote-web-runtime.js'
import { DSH_VERSION } from '../../shared/contracts/version.js'

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
      const stateDirectory = process.env.DSH_CODINGNS_STATE_DIR?.trim() || join(homedir(), '.config', 'dsh-codingns')
      const credentials = new FileCodingNsCredentialStore(join(stateDirectory, 'codingns-credentials.json'))
      const dshCredentials = new FileDshDeviceCredentialStore(join(stateDirectory, 'device-credential.json'))
      let session: CodingNsAuthSession | null = null
      let sessionBaseUrl: string | null = null
      let dshRuntime: DshHostDeviceRuntime | null = null
      let dshStartPromise: Promise<void> | null = null
      let disposed = false

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

      const startDsh = async (target: CodingNsAuthSession): Promise<void> => {
        if (disposed || context.resources.disposed) return
        if (dshRuntime !== null) return
        if (dshStartPromise !== null) return dshStartPromise
        const accessToken = target.getAccessToken()
        if (!accessToken) return
        dshStartPromise = (async () => {
          try {
            const gatewayFeatures = [createDshRpcGatewayFeature(context.services.rpc)]
            if (context.services.dshWebPort !== undefined) {
              gatewayFeatures.push(createRemoteWebRuntimeFeature({
                provider: createLocalDshWebRuntimeProvider({
                  port: context.services.dshWebPort,
                  dshVersion: DSH_VERSION,
                  ...(context.services.dshWebAuthenticatedUrl === undefined ? {} : { authenticatedUrl: context.services.dshWebAuthenticatedUrl }),
                }),
              }))
            }
            if (disposed || context.resources.disposed) return
            const runtime = await startDshHostDeviceRuntime({
              controlClient: target.getControlClient(),
              accessToken,
              credentialStore: dshCredentials,
              resources: context.resources,
              gatewayFeatures,
            })
            if (disposed || context.resources.disposed) {
              await runtime.stop()
              return
            }
            dshRuntime = runtime
          } catch (error) {
            // DSH 设备服务不可用时不应破坏已有 CodingNS 登录；下次登录/显式 start 会重试。
            console.error('dsh-codingns: DSH Host runtime 启动失败', error)
          } finally {
            dshStartPromise = null
          }
        })()
        return dshStartPromise
      }

      const actions: Record<string, AuthAction> = {
        snapshot: () => session?.snapshot() ?? LOGGED_OUT_SNAPSHOT,
        login: async (payload) => {
          const input = parseLogin(payload)
          const target = await ensureSession(input.controlBaseUrl)
          await target.login({ email: input.email, password: input.password })
          await startDsh(target)
          return target.snapshot()
        },
        logout: async () => {
          await dshRuntime?.stop()
          dshRuntime = null
          if (session) await session.logout()
          return { status: 'logged_out' }
        },
        devices: () => requireSession().getDevices(),
        bind: (payload) => requireSession().bindHost(parseHostBind(payload)),
        unbind: (payload) => requireSession().unbindHost(parseStringField(payload, 'bindingId')),
        signalingTicket: (payload) => requireSession().createClientSignalingTicket(parseOptionalStringField(payload, 'tunnelDomain')),
        'dsh/device/list': () => requireSession().getControlClient().listDshDevices(requireSession().getAccessToken() ?? ''),
        'dsh/device/start': async () => { await startDsh(requireSession()); return dshRuntime?.device ?? null },
        'dsh/device/stop': async () => { await dshRuntime?.stop(); dshRuntime = null; return { stopped: true } },
        'dsh/device/status': () => dshRuntime ? { device: dshRuntime.device, online: true } : { device: null, online: false },
        'dsh/relayTicket': async (payload) => {
          const target = requireSession()
          if (!dshRuntime) await startDsh(target)
          if (!dshRuntime) throw new CodingNsRpcError('DSH_DEVICE_OFFLINE', 'DSH Host 尚未上线')
          const input = isRecord(payload) && typeof payload.dshDeviceId === 'string' ? payload.dshDeviceId.trim() : ''
          if (!input || input !== dshRuntime.credential.deviceId) throw new CodingNsRpcError('DSH_DEVICE_NOT_FOUND', '请求的 DSH 设备不是当前 Host')
          const accessToken = target.getAccessToken()
          if (!accessToken) throw new CodingNsRpcError('CODINGNS_RPC_UNAUTHENTICATED', 'CodingNS 尚未登录')
          const request: DshRelayTicketRequest = {
            dshDeviceId: dshRuntime.credential.deviceId,
            deviceCredential: dshRuntime.credential.deviceCredential,
            hostDtlsFingerprint: dshRuntime.runtime.identity.fingerprint,
            credentialVersion: dshRuntime.credential.credentialVersion,
            role: 'client',
          }
          return target.getControlClient().createDshRelayTicket(accessToken, request)
        },
      }

      context.resources.add(context.services.rpc.register('auth', (action, payload) => {
        const handler = actions[action]
        if (handler === undefined) {
          throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 CodingNS RPC: auth/${action}`)
        }
        return handler(payload)
      }))

      // Host 重启后优先恢复 refresh token，并尝试把已注册的 DSH 设备重新上线。
      void (async () => {
        try {
          const saved = await credentials.read()
          if (!saved) return
          const target = await ensureSession(saved.controlBaseUrl)
          await target.restore()
          await startDsh(target)
        } catch (error) {
          console.error('dsh-codingns: 恢复 DSH Host 会话失败', error)
        }
      })()

      context.resources.add(async () => {
        disposed = true
        await dshRuntime?.stop()
        dshRuntime = null
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

function parseOptionalStringField(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) throw new TypeError(`${field} 参数必须是对象`)
  const raw = value[field]
  if (raw === undefined || raw === null || raw === '') return undefined
  return requireString(raw, field)
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
