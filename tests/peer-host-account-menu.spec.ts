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
  assert.match(accountBar, /t\('accountBar\.managePeerHost'\)/u)
  assert.match(accountBar, /dispatchEvent\(new Event\(PEER_HOST_OPEN_EVENT\)\)/u)
  assert.doesNotMatch(feature, /startPeerHostConnectionButton\(\)/u)
})

test('PeerHost 启用后回环和 Desktop 页面也显示统一账户入口', async () => {
  const accountBar = await readFile(join(projectRoot, 'src/client/account-bar.ts'), 'utf8')
  assert.match(accountBar, /settingsStore\?\.getSnapshot\(\)\.value\?\.modules\.peerHost === true/u)
  assert.match(accountBar, /location\.protocol\.toLowerCase\(\) === 'dsh-app:'/u)
  assert.match(accountBar, /peerHostModuleEnabled\(\) && \(isLoopbackPage\(\) \|\| isDesktopPage\(\)\)/u)
  // 入口可见性必须与能力状态一致：结构不支持或 shim 未安装时不显示入口。
  assert.match(accountBar, /if \(!isPeerHostTransportWrappable\(\)\) return false/u)
  assert.match(accountBar, /readDshPeerHostPrebootShimState\(\)/u)
  assert.match(accountBar, /settingsStore\?\.subscribe\(\(\) => renderAll\(\)\)/u)
})

test('Desktop 账户入口追加到原生账户组件右侧并保持同一行', async () => {
  const accountBar = await readFile(join(projectRoot, 'src/client/account-bar.ts'), 'utf8')
  // settings.launcher 是 display: contents；追加到出口末尾后，插件按钮才会成为
  // triggerRow 的最后一个 flex 子项，不能再把宿主行改成可换行布局。
  assert.match(accountBar, /if \(match\.kind === 'launcher-slot'\) container\.append\(button\)/u)
  // 宿主 triggerRow 自己负责换行策略，插件只能设置入口自身的顺序，不能改写宿主行。
  assert.doesNotMatch(accountBar, /row\.style\.flexWrap/u)
  assert.match(accountBar, /button\.style\.marginLeft = 'auto'/u)
  assert.match(accountBar, /createAccountButton\(root, isDesktopPage\(\)\)/u)
  assert.match(accountBar, /function createConnectionIcon\(dom: Document\)/u)
  assert.match(accountBar, /desktop \? t\('accountBar\.connectionManageTitle'\) : t\('accountBar\.identityClickHint', \{ identity \}\)/u)
})

test('Desktop 设置弹窗出现重复槽位时复用既有账户入口', async () => {
  const accountBar = await readFile(join(projectRoot, 'src/client/account-bar.ts'), 'utf8')
  // 设置弹窗可能让页面同时存在多个 settings.launcher；已有按钮必须按父容器复用，
  // 不能再次创建并把连接管理按钮插入工作区设置行。
  assert.match(accountBar, /const existing = root\.querySelector<HTMLButtonElement>\(`button\[\$\{ACCOUNT_ATTRIBUTE\}\]`\)/u)
  assert.match(accountBar, /matchForAccountContainer\(existing\.parentElement\)/u)
  assert.match(accountBar, /root\.querySelectorAll<HTMLButtonElement>\(`button\[\$\{ACCOUNT_ATTRIBUTE\}\]`\)/u)
  assert.match(accountBar, /function matchForAccountContainer\(container: HTMLElement\): SettingsAnchorMatch \| null/u)
})

test('PeerHost 管理表单自动识别账号但不读取密码或使用 prompt', async () => {
  const panel = await readFile(join(projectRoot, 'src/client/peer-host-management-panel.ts'), 'utf8')
  assert.match(panel, /fetchLocalIdentity/u)
  assert.match(panel, /readRelayLoginIdentity/u)
  assert.match(panel, /data-codingns-peer-host-username/u)
  assert.match(panel, /data-codingns-peer-host-password/u)
  assert.match(panel, /peerHost\.identityLocal/u)
  assert.doesNotMatch(panel, /\.prompt\(/u)
})
