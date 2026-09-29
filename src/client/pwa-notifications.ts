/**
 * 通知与推送客户端。
 *
 * 只使用浏览器原生能力，不引入依赖：
 * - 通知：要求安全上下文与用户授权；已注册 Service Worker 时走
 *   `registration.showNotification`，否则退回页面 `new Notification`。
 * - 推送：先要有一个活跃的 Service Worker 注册（由启动页注入脚本完成），
 *   这里只负责 `pushManager.subscribe` 并把订阅凭据交给 Host 保存。
 *
 * 所有方法在能力缺失时返回可解释状态而不抛异常，设置面板据此灰显输入。
 */

export interface PwaPushSubscriptionJson {
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
}

export type PwaNotificationPermission = 'default' | 'granted' | 'denied' | 'unsupported'

export interface PwaNotificationStatus {
  /** 浏览器是否提供通知能力。 */
  readonly supported: boolean
  /** 是否处于安全上下文（HTTPS 或回环地址）。 */
  readonly secure: boolean
  readonly permission: PwaNotificationPermission
  /** 是否已有可用的 Service Worker 注册（推送的前提）。 */
  readonly serviceWorker: boolean
}

export interface PwaPushSubscriptionLike {
  readonly endpoint: string
  toJSON?(): { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  unsubscribe(): Promise<boolean>
}

export interface PwaServiceWorkerRegistrationLike {
  readonly active?: unknown
  readonly pushManager?: {
    getSubscription(): Promise<PwaPushSubscriptionLike | null>
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<PwaPushSubscriptionLike>
  }
  showNotification?(title: string, options?: Record<string, unknown>): Promise<void>
  unregister?(): Promise<boolean>
}

export interface PwaNotificationNavigatorLike {
  readonly serviceWorker?: {
    getRegistration(scope?: string): Promise<PwaServiceWorkerRegistrationLike | undefined>
    ready?: Promise<PwaServiceWorkerRegistrationLike>
  }
}

export interface PwaNotificationGlobalLike {
  readonly isSecureContext?: boolean
  readonly Notification?: {
    readonly permission: string
    requestPermission(): Promise<string>
  }
  readonly navigator?: PwaNotificationNavigatorLike
}

export interface PwaNotificationClientOptions {
  readonly global?: PwaNotificationGlobalLike
  /** 注册作用域，需与启动页脚本注册的 `/sw.js` 一致。 */
  readonly scope?: string
  readonly serviceWorkerUrl?: string
}

export interface PwaNotificationPayload {
  readonly title: string
  readonly body?: string
  readonly tag?: string
  readonly url?: string
}

/** 通知与推送的统一入口；同一实例可重复调用。 */
export class PwaNotificationClient {
  private readonly globalLike: PwaNotificationGlobalLike
  private readonly scope: string
  private readonly serviceWorkerUrl: string

  constructor(options: PwaNotificationClientOptions = {}) {
    this.globalLike = options.global ?? (globalThis as unknown as PwaNotificationGlobalLike)
    this.scope = options.scope ?? '/'
    this.serviceWorkerUrl = options.serviceWorkerUrl ?? '/sw.js'
  }

  /** 当前能力与授权状态；不会触发任何权限请求。 */
  async status(): Promise<PwaNotificationStatus> {
    const secure = this.globalLike.isSecureContext === true
    const notification = this.globalLike.Notification
    const permission = notification === undefined
      ? 'unsupported'
      : normalizePermission(notification.permission)
    const registration = await this.registration()
    return {
      supported: notification !== undefined,
      secure,
      permission,
      serviceWorker: registration !== undefined,
    }
  }

  /** 请求通知权限；必须由用户手势触发（浏览器要求），失败时返回当前状态。 */
  async requestPermission(): Promise<PwaNotificationStatus> {
    const notification = this.globalLike.Notification
    if (notification !== undefined && this.globalLike.isSecureContext === true) {
      try {
        await notification.requestPermission()
      } catch {
        // 直接打开页面等场景下浏览器会拒绝；状态查询会给出真实结果。
      }
    }
    return this.status()
  }

  /** 发送本地通知（不需要推送服务）。 */
  async notify(payload: PwaNotificationPayload): Promise<boolean> {
    const notification = this.globalLike.Notification
    if (notification === undefined || normalizePermission(notification.permission) !== 'granted') return false
    const options: Record<string, unknown> = {
      ...(payload.body === undefined ? {} : { body: payload.body }),
      ...(payload.tag === undefined ? {} : { tag: payload.tag }),
      ...(payload.url === undefined ? {} : { data: { url: payload.url } }),
    }
    const registration = await this.registration()
    if (registration?.showNotification !== undefined) {
      try {
        await registration.showNotification(payload.title, options)
        return true
      } catch {
        // 落到页面级通知；iOS 上只有已安装的 Web App 才能成功。
      }
    }
    try {
      const notificationApi = this.globalLike.Notification
      if (notificationApi === undefined) return false
      const Constructor = this.globalLike.Notification as unknown as new (title: string, options?: Record<string, unknown>) => unknown
      new Constructor(payload.title, options)
      return true
    } catch {
      return false
    }
  }

  /** 当前订阅；没有 Service Worker 或未订阅时返回 null。 */
  async currentSubscription(): Promise<PwaPushSubscriptionJson | null> {
    const registration = await this.registration()
    const pushManager = registration?.pushManager
    if (pushManager === undefined) return null
    try {
      const subscription = await pushManager.getSubscription()
      return subscription === null ? null : toSubscriptionJson(subscription)
    } catch {
      return null
    }
  }

  /** 订阅推送；applicationServerKey 为 Host 下发的 VAPID 公钥（base64url）。 */
  async subscribe(vapidPublicKey: string): Promise<PwaPushSubscriptionJson> {
    const registration = await this.registration()
    const pushManager = registration?.pushManager
    if (pushManager === undefined) throw new Error('推送不可用：没有活跃的 Service Worker 注册')
    const applicationServerKey = base64UrlToBytes(vapidPublicKey)
    const existing = await pushManager.getSubscription().catch(() => null)
    const subscription = existing ?? await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
    return toSubscriptionJson(subscription)
  }

  /** 取消当前订阅；没有订阅时返回 false。 */
  async unsubscribe(): Promise<boolean> {
    const registration = await this.registration()
    const pushManager = registration?.pushManager
    if (pushManager === undefined) return false
    const subscription = await pushManager.getSubscription().catch(() => null)
    if (subscription === null || subscription === undefined) return false
    try {
      return await subscription.unsubscribe()
    } catch {
      return false
    }
  }

  /** 注销 Service Worker：逃生口，同时通知 SW 清理缓存。 */
  async unregisterServiceWorker(): Promise<boolean> {
    const registration = await this.registration()
    if (registration?.unregister === undefined) return false
    try {
      const active = registration.active
      if (active !== undefined && active !== null && typeof (active as { postMessage?: unknown }).postMessage === 'function') {
        ;(active as { postMessage(message: unknown): void }).postMessage({ type: 'codingns-sw-unregister' })
      }
      return await registration.unregister()
    } catch {
      return false
    }
  }

  private async registration(): Promise<PwaServiceWorkerRegistrationLike | undefined> {
    const serviceWorker = this.globalLike.navigator?.serviceWorker
    if (serviceWorker === undefined) return undefined
    try {
      const direct = await serviceWorker.getRegistration(this.scope)
      if (direct !== undefined) return direct
    } catch {
      // 回退到 ready；两种路径在浏览器里等价，差别只在是否需要等待激活。
    }
    if (serviceWorker.ready === undefined) return undefined
    try {
      return await serviceWorker.ready
    } catch {
      return undefined
    }
  }
}

export function createPwaNotificationClient(options: PwaNotificationClientOptions = {}): PwaNotificationClient {
  return new PwaNotificationClient(options)
}

function normalizePermission(value: string): PwaNotificationPermission {
  return value === 'granted' || value === 'denied' || value === 'default' ? value : 'unsupported'
}

function toSubscriptionJson(subscription: PwaPushSubscriptionLike): PwaPushSubscriptionJson {
  const raw = typeof subscription.toJSON === 'function'
    ? subscription.toJSON()
    : { endpoint: subscription.endpoint, keys: undefined }
  const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint : subscription.endpoint
  const p256dh = typeof raw.keys?.p256dh === 'string' ? raw.keys.p256dh : undefined
  const auth = typeof raw.keys?.auth === 'string' ? raw.keys.auth : undefined
  if (endpoint === undefined || p256dh === undefined || auth === undefined) {
    throw new Error('订阅缺少 endpoint 或密钥，无法上报')
  }
  return { endpoint, keys: { p256dh, auth } }
}

/** base64url → Uint8Array；VAPID 公钥是 65 字节的非压缩点。 */
export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
