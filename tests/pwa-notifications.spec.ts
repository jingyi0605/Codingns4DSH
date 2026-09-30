import assert from 'node:assert/strict'
import test from 'node:test'
import { PwaNotificationClient, type PwaNotificationGlobalLike } from '../data/build/dist/client/pwa-notifications.js'

test('通知状态报告 secure/supported，并把振动模式传给浏览器', async () => {
  const shown: Array<{ title: string; options?: Record<string, unknown> }> = []
  const NotificationCtor = function (this: unknown, title: string, options?: Record<string, unknown>): void {
    shown.push({ title, options })
  } as unknown as { new (title: string, options?: Record<string, unknown>): unknown; permission: string; requestPermission(): Promise<string> }
  NotificationCtor.permission = 'granted'
  NotificationCtor.requestPermission = async () => 'granted'
  const globalLike: PwaNotificationGlobalLike = {
    isSecureContext: true,
    Notification: NotificationCtor,
    navigator: { getRegistration: async () => undefined },
  }
  const client = new PwaNotificationClient({ global: globalLike })
  assert.deepEqual(await client.status(), { supported: true, secure: true, permission: 'granted', serviceWorker: false })
  assert.equal(await client.notify({ title: 'DSH', body: '完成', vibrate: [100, 50, 100] }), true)
  assert.deepEqual(shown, [{ title: 'DSH', options: { body: '完成', vibrate: [100, 50, 100] } }])
})

test('通知能力缺失时安全降级', async () => {
  const client = new PwaNotificationClient({ global: { isSecureContext: false } })
  assert.deepEqual(await client.status(), { supported: false, secure: false, permission: 'unsupported', serviceWorker: false })
  assert.equal(await client.notify({ title: 'DSH' }), false)
})
