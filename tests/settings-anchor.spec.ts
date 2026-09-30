import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  SETTINGS_ANCHOR_SELECTORS,
  SETTINGS_BUTTON_SELECTOR,
  SETTINGS_LAUNCHER_SLOT_SELECTOR,
  resolveSettingsAnchor,
  settingsAnchorContainer,
} from '../data/build/dist/client/settings-anchor.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('锚点候选把原生齿轮排在槽位出口之前，保持 Web 行为不变', () => {
  assert.deepEqual([...SETTINGS_ANCHOR_SELECTORS], [SETTINGS_BUTTON_SELECTOR, SETTINGS_LAUNCHER_SLOT_SELECTOR])
  assert.equal(SETTINGS_BUTTON_SELECTOR, 'button[aria-label="设置"]')
  assert.equal(SETTINGS_LAUNCHER_SLOT_SELECTOR, '[data-slot="settings.launcher"]')
})

test('Web 页面命中原生齿轮时不再查询槽位出口', () => {
  const gear = { id: 'gear' } as unknown as HTMLElement
  const slot = { id: 'slot' } as unknown as HTMLElement
  const queried: string[] = []
  const match = resolveSettingsAnchor((selector) => {
    queried.push(selector)
    return selector === SETTINGS_BUTTON_SELECTOR ? gear : slot
  })
  assert.equal(match?.node, gear)
  assert.equal(match?.kind, 'settings-button')
  // 齿轮命中即返回，槽位查询不应发生，避免同一页面出现两个落点。
  assert.deepEqual(queried, [SETTINGS_BUTTON_SELECTOR])
})

test('Desktop 没有齿轮时回退到 settings.launcher 槽位出口', () => {
  const slot = { id: 'slot' } as unknown as HTMLElement
  const queried: string[] = []
  const match = resolveSettingsAnchor((selector) => {
    queried.push(selector)
    return selector === SETTINGS_LAUNCHER_SLOT_SELECTOR ? slot : null
  })
  assert.equal(match?.node, slot)
  // Desktop 的槽位出口里是 DSH 自己的账户菜单，调用方必须按 launcher-slot 分支
  // 处理，不能覆盖 DSH 的 triggerRow 布局。
  assert.equal(match?.kind, 'launcher-slot')
  assert.deepEqual(queried, [SETTINGS_BUTTON_SELECTOR, SETTINGS_LAUNCHER_SLOT_SELECTOR])
})

test('两种锚点都缺失时返回 null，让调用方继续等待 DOM 变化', () => {
  assert.equal(resolveSettingsAnchor(() => null), null)
})

test('槽位出口容器：齿轮取父节点，出口本身直接用', () => {
  const outlet = { id: 'outlet' } as unknown as HTMLElement
  const gear = { id: 'gear', parentElement: outlet } as unknown as HTMLElement
  assert.equal(settingsAnchorContainer({ kind: 'settings-button', node: gear }), outlet)
  assert.equal(settingsAnchorContainer({ kind: 'launcher-slot', node: outlet }), outlet)
  // 齿轮游离在文档之外时没有容器，调用方必须继续等待而不是抛错。
  assert.equal(settingsAnchorContainer({ kind: 'settings-button', node: { parentElement: null } as unknown as HTMLElement }), null)
})

test('账户入口通过共用锚点解析挂载，不再硬编码齿轮选择器', async () => {
  const [accountBar, anchor] = await Promise.all([
    readFile(join(projectRoot, 'src/client/account-bar.ts'), 'utf8'),
    readFile(join(projectRoot, 'src/client/settings-anchor.ts'), 'utf8'),
  ])
  // Desktop 下 DSH 账户菜单占用 settings.launcher 单槽位，齿轮 fallback 不渲染；
  // 账户入口必须走锚点解析，否则左下角既不显示用户图标也进不去 PeerHost 管理。
  assert.match(accountBar, /import \{ resolveSettingsAnchor, settingsAnchorContainer, type SettingsAnchorKind \} from '\.\/settings-anchor\.js'/u)
  assert.equal([...accountBar.matchAll(/resolveSettingsAnchor\(\(selector\) => root\.querySelector<HTMLElement>\(selector\)\)/gu)].length, 2)
  assert.doesNotMatch(accountBar, /querySelector<HTMLElement>\('button\[aria-label="设置"\]'\)/u)
  // Desktop 的宿主行由插件保持 nowrap，避免原生账户组件与入口被拆成两行。
  assert.match(accountBar, /if \(kind === 'launcher-slot'\) \{/u)
  // 选择器只允许在锚点模块里定义一份，避免调用点各自漂移。
  assert.match(anchor, /'\[data-slot="settings\.launcher"\]'/u)
  assert.match(anchor, /button\[aria-label="设置"\]/u)
})

test('PeerHost 旧按钮工厂同样改用共用锚点，Desktop 下不再依赖齿轮', async () => {
  const source = await readFile(join(projectRoot, 'src/client/peer-host-connection-button.ts'), 'utf8')
  assert.match(source, /import \{ resolveSettingsAnchor, settingsAnchorContainer \} from '\.\/settings-anchor\.js'/u)
  assert.doesNotMatch(source, /querySelector<HTMLButtonElement>\('button\[aria-label="设置"\]'\)/u)
})
