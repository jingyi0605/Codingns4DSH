import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hostBrowserText,
  readDshLocalePreference,
  resolveAcceptLanguageLocale,
  resolveHostPushLocale,
} from '../data/build/dist/host/browser-text.js'
import { createPwaManifest } from '../data/build/dist/host/modules/pwa/pwa-assets.js'
import { createPwaSessionNotification } from '../data/build/dist/host/modules/pwa/index.js'

test('Accept-Language 只认 DSH 支持的 zh/en，其它语言回退中文', () => {
  assert.equal(resolveAcceptLanguageLocale('zh-CN,zh;q=0.9,en;q=0.8'), 'zh')
  assert.equal(resolveAcceptLanguageLocale('en-US,en;q=0.9'), 'en')
  assert.equal(resolveAcceptLanguageLocale('fr-FR,fr;q=0.9,en;q=0.8'), 'en')
  assert.equal(resolveAcceptLanguageLocale('de-DE'), 'zh')
  assert.equal(resolveAcceptLanguageLocale(undefined), 'zh')
})

test('Host 词典按语言取词并支持 {name} 插值', () => {
  assert.equal(hostBrowserText('zh', 'login.submit'), '登录 DSH Web')
  assert.equal(hostBrowserText('en', 'login.submit'), 'Sign in to DSH Web')
  assert.equal(hostBrowserText('zh', 'login.rateLimited', { seconds: 30 }), '登录尝试过于频繁，请 30 秒后重试')
  assert.equal(hostBrowserText('en', 'push.turnEndBody', { sessionId: 's-1' }), 'Session s-1 finished its current turn.')
})

test('DSH locale 设置的显式偏好优先于默认语言', () => {
  const direct = { get: (namespace: string) => (namespace === 'locale' ? { preference: 'en' } : undefined) }
  assert.equal(readDshLocalePreference(direct as never), 'en')
  assert.equal(resolveHostPushLocale(direct as never), 'en')

  // get 不可用时回退 describe()，字段缺失时视为未选择。
  const described = { describe: () => [{ ns: 'locale', value: { revision: 3 }, revision: 3, writable: false }] }
  assert.equal(readDshLocalePreference(described as never), null)
  assert.equal(resolveHostPushLocale(described as never), 'zh')
  assert.equal(resolveHostPushLocale(undefined), 'zh')
})

test('PWA manifest 描述随语言变化', () => {
  assert.equal(createPwaManifest('zh').description, 'DeepSeek Harness Web 应用（Codingns4DSH 局域网入口）')
  assert.equal(createPwaManifest('en').description, 'DeepSeek Harness Web app (Codingns4DSH LAN entry)')
})

test('PWA 会话通知按语言生成标题与正文', () => {
  const session = { id: 'session/1' }
  const turnEnd = { type: 'turn/end' }
  const zh = createPwaSessionNotification({ session, event: turnEnd, locale: 'zh' })
  const en = createPwaSessionNotification({ session, event: turnEnd, locale: 'en' })
  assert.equal(zh?.title, 'DSH 会话已完成')
  assert.equal(zh?.body, '会话 session/1 已完成当前轮次。')
  assert.equal(en?.title, 'DSH session finished')
  assert.equal(en?.body, 'Session session/1 finished its current turn.')
  // 缺省仍是中文，保证旧调用方行为不变。
  assert.equal(createPwaSessionNotification({ session, event: turnEnd })?.title, 'DSH 会话已完成')
})
