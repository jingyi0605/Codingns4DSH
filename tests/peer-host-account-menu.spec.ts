import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = join(fileURLToPath(new URL('..', import.meta.url)))

test('PeerHost 管理入口归属于统一账户菜单，不再由 Feature 注入独立 Host 按钮', async () => {
  const accountBar = await readFile(join(projectRoot, 'src/client/account-bar.ts'), 'utf8')
  const feature = await readFile(join(projectRoot, 'src/client/features/peer-host.ts'), 'utf8')
  assert.match(accountBar, /PEER_HOST_OPEN_EVENT/u)
  assert.match(accountBar, /管理 PeerHost/u)
  assert.match(accountBar, /dispatchEvent\(new Event\(PEER_HOST_OPEN_EVENT\)\)/u)
  assert.doesNotMatch(feature, /startPeerHostConnectionButton\(\)/u)
})

test('PeerHost 启用后回环和 Desktop 页面也显示统一账户入口', async () => {
  const accountBar = await readFile(join(projectRoot, 'src/client/account-bar.ts'), 'utf8')
  assert.match(accountBar, /settingsStore\?\.getSnapshot\(\)\.value\?\.modules\.peerHost === true/u)
  assert.match(accountBar, /location\.protocol\.toLowerCase\(\) === 'dsh-app:'/u)
  assert.match(accountBar, /peerHostModuleEnabled\(\) && \(isLoopbackPage\(\) \|\| isDesktopPage\(\)\)/u)
  assert.match(accountBar, /settingsStore\?\.subscribe\(\(\) => renderAll\(\)\)/u)
})

test('PeerHost 管理表单自动识别账号但不读取密码或使用 prompt', async () => {
  const panel = await readFile(join(projectRoot, 'src/client/peer-host-management-panel.ts'), 'utf8')
  assert.match(panel, /fetchLocalIdentity/u)
  assert.match(panel, /readRelayLoginIdentity/u)
  assert.match(panel, /data-codingns-peer-host-username/u)
  assert.match(panel, /data-codingns-peer-host-password/u)
  assert.match(panel, /不会自动登录远程 Host/u)
  assert.doesNotMatch(panel, /\.prompt\(/u)
})
