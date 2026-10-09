import type { IncomingMessage, ServerResponse } from 'node:http'
import { isDesktopAssistantHost, readDesktopAssistantNoticeFeedback, readDesktopAssistantPresentation, DESKTOP_ASSISTANT_CHANNEL } from '../../shared/desktop-assistant.js'
import { normalizeAssistantAppearance, selectedAssistantAvatar, resolveAssistantAvatarAsset } from '../../shared/assistant-avatar.js'
import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsHostServices } from '../features/types.js'
import { getAssistantAvatarPackages } from '../avatar/registry.js'
import { createAssistantAvatarRouteHandler } from '../features/assistant-avatar-runtime.js'
import { DesktopAssistantController } from './controller.js'
import { openDesktopAssistantPage } from './server.js'
import { launchDesktopAssistant } from './launcher.js'
import { confirmDesktopAssistantNotification, desktopAssistantNotificationPresentation, getDesktopAssistantNotifications } from './notifications.js'

/** 原生窗口能力只在官方 Desktop Host 中启用，不依据客户端宣称的平台启动进程。 */
export function createDesktopAssistantFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: { name: 'desktopAssistant', version: '0.1.0', enabledByDefault: true, dependencies: [], runtime: 'host' },
    start(context) {
      const supported = isDesktopAssistantHost(process.platform, process.versions.electron, process.env.ELECTRON_RUN_AS_NODE, process.argv[1] ?? '')
      const ctx = context.services.dshContext
      if (!supported || !ctx) return
      const assets = createAssistantAvatarRouteHandler(getAssistantAvatarPackages(context.services), true)
      let notificationCursor: string | undefined
      const controller = new DesktopAssistantController({ supported, launch: launchDesktopAssistant,
        openPage: (frame) => openDesktopAssistantPage({ frame, assets }),
        onNoticePresented: (event) => confirmDesktopAssistantNotification(context.services, event),
        onNoticePage: (cursor) => {
          const source = getDesktopAssistantNotifications(context.services)
          if (!source) throw new Error('通知中心尚未连接')
          // 先校验游标，再替换当前页；无效游标不能破坏后续原生刷新链。
          source.read({ ...(cursor === undefined ? {} : { cursor }), limit: 20 })
          notificationCursor = cursor
        },
        readFrame: (presentation) => {
          const settings = context.services.settings?.get()
          if (!settings?.modules.globalVoiceAssistant || settings.assistant.profile?.initialized !== true) return undefined
          const appearance = normalizeAssistantAppearance(settings.assistant.appearance)
          if (!appearance.floatingEnabled) return undefined
          const model = selectedAssistantAvatar(appearance)
          // 第三方自定义渲染器在主 Client 注册，无法假设它已存在于独立页面。
          if (!['builtin', 'image', 'spritesheet', 'live2d'].includes(resolveAssistantAvatarAsset(model, 'floating').renderer)) return undefined
          if (settings.assistant.notifications?.enabled === false) {
            const { notification, notificationSnapshot, reaction, ...base } = presentation
            return { ...base, model, size: appearance.floatingSize }
          }
          const next = desktopAssistantNotificationPresentation(context.services, presentation, { ...(notificationCursor === undefined ? {} : { cursor: notificationCursor }), limit: 20 })
          if (next.notificationSnapshot?.reset) notificationCursor = undefined
          return { ...next, model, size: appearance.floatingSize }
        },
      })
      const webServer = ctx.get('webServer') as unknown as { register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }): () => Promise<void> }
      context.resources.add(webServer.register({ kind: 'prefix', path: DESKTOP_ASSISTANT_CHANNEL,
        handler: (req, res) => handleDesktopAssistantRequest(req, res, (headers) => ctx.connection.requestRejection({ headers }), controller),
      }))
      const unwatch = context.services.settings?.watch(() => { void controller.refresh().catch(() => undefined) })
      if (unwatch) context.resources.add(unwatch)
      // 独立 Host 时钟不会被隐藏主页面的浏览器计时限流；仅修订变化时更新窗口。
      let notificationKey = ''
      const notificationTimer = setInterval(() => {
        try {
          const source = getDesktopAssistantNotifications(context.services)
          const snapshot = source?.read()
          const key = snapshot === undefined ? '' : `${snapshot.generation}:${snapshot.revision}`
          if (key === notificationKey) return
          notificationKey = key
          void controller.refresh().catch(() => undefined)
        } catch { /* 中心销毁/换代期间的迟到时钟不影响原生进程和 Host。 */ }
      }, 250)
      context.resources.add(() => clearInterval(notificationTimer))
      context.resources.add(() => controller.dispose())
    },
  }
}

/** 同时要求物理回环连接与 DSH 认证；PeerHost 转发与普通远程网页不能启动本机窗口。 */
export async function handleDesktopAssistantRequest(request: IncomingMessage, response: ServerResponse,
  rejection: (headers: IncomingMessage['headers']) => number | undefined, controller: DesktopAssistantController): Promise<void> {
  // 官方 dsh-app 转发会移除 Origin 并使用回环 Host；反代和 Web 页面不能借回环代理进入。
  const localHost = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/u.test(request.headers.host ?? '')
  const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip'].some((key) => request.headers[key] !== undefined)
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')
    || !localHost || forwarded || request.headers.origin !== undefined
    || rejection(request.headers) !== undefined) { response.writeHead(403).end(); return }
  if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0] !== 'application/json') { response.writeHead(405).end(); return }
  let rpcId = ''
  try {
    const chunks: Buffer[] = []; let length = 0
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length; if (length > 320000) throw new Error('悬浮请求过大')
      chunks.push(bytes)
    }
    const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    if (envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 160) throw new Error('悬浮协议无效')
    rpcId = envelope.rpcId
    const action = envelope.method
    if (!['attach', 'update', 'detach'].includes(String(action)) || request.url?.split('?')[0] !== `${DESKTOP_ASSISTANT_CHANNEL}/${String(action)}`) throw new Error('悬浮操作无效')
    const input = envelope.payload as Record<string, unknown>
    if (!input || typeof input.ownerId !== 'string' || !/^[a-zA-Z0-9:-]{8,160}$/u.test(input.ownerId)) throw new Error('悬浮调用方无效')
    let value
    if (action === 'attach') value = controller.attach(input.ownerId)
    else if (action === 'detach') { await controller.detach(input.ownerId); value = controller.status(input.ownerId) }
    else {
      if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < 0) throw new Error('悬浮更新序号无效')
      const ack = input.noticeAck as { generation?: unknown; sequence?: unknown } | undefined
      if (ack !== undefined && (!ack || !Number.isSafeInteger(ack.generation) || !Number.isSafeInteger(ack.sequence)
        || Number(ack.generation) < 0 || Number(ack.sequence) < 0)) throw new Error('通知确认序号无效')
      value = await controller.update(input.ownerId, Number(input.sequence), readDesktopAssistantPresentation(input.presentation),
        ack === undefined ? undefined : { generation: Number(ack.generation), sequence: Number(ack.sequence) },
        input.noticeFeedback === undefined ? undefined : readDesktopAssistantNoticeFeedback(input.noticeFeedback))
    }
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }))
  } catch (error) {
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ type: 'server-response', rpcId,
      result: { ok: false, error: { code: 'desktop_assistant_unavailable', message: error instanceof Error ? error.message : String(error), details: {} } } }))
  }
}
