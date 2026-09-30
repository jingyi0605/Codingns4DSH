import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('局域网入口的 PWA 配置由「移动端访问增强」卡片承载', async () => {
  const mobile = await readFile(join(root, 'src/client/features/mobile-access-panel.ts'), 'utf8')
  const lan = await readFile(join(root, 'src/client/features/lan-access-panel.ts'), 'utf8')

  // 移动端卡片：保留原有窄屏字段，并接管 lanAccessDsh.pwa 的读写与通知/推送操作。
  assert.match(mobile, /CODINGNS_MOBILE_ACCESS_FIELD/u)
  assert.match(mobile, /CODINGNS_LAN_ACCESS_DSH_FIELD/u)
  assert.match(mobile, /'lanAccessDsh\/pwa\/vapid'/u)
  assert.match(mobile, /'lanAccessDsh\/pwa\/push\/subscribe'/u)
  assert.match(mobile, /'lanAccessDsh\/pwa\/push\/test'/u)
  assert.match(mobile, /'mobile\.sidebarGestures'/u)
  assert.match(mobile, /'mobile\.optimizeSettingsOnMobile'/u)
  assert.match(mobile, /CODINGNS_MOBILE_ACCESS_FIELD, field/u)
  assert.doesNotMatch(mobile, /path: \['workspaceSessionEnhancement', field\]/u)
  for (const key of [
    'lan.pwa.title',
    'lan.pwa.enabled',
    'lan.pwa.serviceWorker',
    'lan.pwa.installPrompt',
    'lan.pwa.notifications',
    'lan.pwa.pushTest',
    'lan.pwa.unregisterSw',
    'mobile.pwaRequiresListener',
  ]) {
    assert.equal(mobile.includes(`'${key}'`), true, `移动端卡片缺少 ${key}`)
  }

  // 局域网卡片：只剩监听映射与回环告警，不再渲染 PWA/通知控件，也不再写 pwa 字段。
  assert.match(lan, /'lan\.pwa\.loopbackWarning'/u)
  for (const removed of [
    'lan.pwa.enabled',
    'lan.pwa.notifications',
    'lan.pwa.pushTest',
    'lanAccessDsh/pwa/push/status',
  ]) {
    assert.equal(lan.includes(removed), false, `局域网卡片仍包含 ${removed}`)
  }
  assert.doesNotMatch(lan, /\bpwa:/u)
})

test('横滑设置只在移动端访问增强卡片中渲染', async () => {
  const mobile = await readFile(join(root, 'src/client/features/mobile-access-panel.ts'), 'utf8')
  const workspace = await readFile(join(root, 'src/client/features/workspace-session-enhancement-panel.ts'), 'utf8')
  assert.match(mobile, /checked: gestures\.sidebarGestures/u)
  assert.match(mobile, /normalizeMobileAccessSettings\(/u)
  assert.doesNotMatch(workspace, /sidebarGestures/u)
})

test('移动端卡片写入的 PWA 设置与局域网卡片共用同一份 Host 设置', async () => {
  const source = await readFile(join(root, 'src/client/features/mobile-access-panel.ts'), 'utf8')
  // 路径必须是 lanAccessDsh.pwa：Host 的 PWA 资产提供者只读这一处。
  assert.match(source, /path: \[CODINGNS_LAN_ACCESS_DSH_FIELD, 'pwa'\]/u)
  assert.match(source, /snapshot\.value\?\.lanAccessDsh\?\.pwa/u)
})
