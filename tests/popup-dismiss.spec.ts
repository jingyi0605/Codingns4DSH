import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  attachOutsideDismissal,
  backdropPointerDownHandler,
  isOutsideDismissRoots,
} from '../data/build/dist/client/popup-dismiss.js'

const projectRoot = new URL('..', import.meta.url).pathname

/** 最小文档替身：只记录监听器，用于验证注册与注销成对发生。 */
function createFakeDocument() {
  const listeners = new Map()
  const key = (type, capture) => `${type}:${capture === true}`
  return {
    listeners,
    addEventListener(type, listener, capture) { listeners.set(key(type, capture), listener) },
    removeEventListener(type, listener, capture) { listeners.delete(key(type, capture)) },
    dispatch(type, event) {
      const listener = listeners.get(key(type, true)) ?? listeners.get(key(type, false))
      listener?.(event)
    },
  }
}

/** 浏览器里 `Node` 存在，Node 测试进程里不存在；这里统一用结构化节点。 */
function fakeNode() { return { nodeType: 1 } }

test('外部判定把弹层根节点与其 Portal 都算作内部', () => {
  const inside = fakeNode()
  const inPortal = fakeNode()
  const outside = fakeNode()
  const root = { nodeType: 1, contains: (target) => target === inside }
  const portal = { nodeType: 1, contains: (target) => target === inPortal }

  assert.equal(isOutsideDismissRoots(inside, [root, portal]), false)
  assert.equal(isOutsideDismissRoots(inPortal, [root, portal]), false)
  assert.equal(isOutsideDismissRoots(outside, [root, portal]), true)
})

test('ref 形态的根节点在挂载前视为无根，非 DOM 目标按外部处理', () => {
  const outside = fakeNode()
  assert.equal(isOutsideDismissRoots(outside, [{ current: null }]), true)
  assert.equal(isOutsideDismissRoots(outside, [undefined]), true)
  // 事件目标缺失或不是节点时不能误判为「内部」，否则弹层永远关不掉。
  assert.equal(isOutsideDismissRoots(undefined, [{ nodeType: 1, contains: () => true }]), true)
  assert.equal(isOutsideDismissRoots({}, [{ nodeType: 1, contains: () => true }]), true)
})

test('命令式关闭监听命中根节点之外才关闭，且 Esc 与注销都生效', () => {
  const doc = createFakeDocument()
  const inside = fakeNode()
  const outside = fakeNode()
  const root = { nodeType: 1, contains: (target) => target === inside }
  let closed = 0
  const detach = attachOutsideDismissal(doc, () => [root], () => { closed += 1 })

  doc.dispatch('pointerdown', { target: inside })
  assert.equal(closed, 0, '点击弹层内部不应关闭')
  doc.dispatch('pointerdown', { target: outside })
  assert.equal(closed, 1, '点击弹层外部应关闭')
  doc.dispatch('keydown', { key: 'Escape' })
  assert.equal(closed, 2, 'Esc 应关闭')
  doc.dispatch('keydown', { key: 'Enter' })
  assert.equal(closed, 2, '其它按键不应关闭')

  detach()
  assert.deepEqual([...doc.listeners.keys()], [], '注销后不应残留监听器')
  doc.dispatch('pointerdown', { target: outside })
  assert.equal(closed, 2)
})

test('遮罩层只在按下遮罩自身时关闭，点面板内部不关闭', () => {
  const overlay = fakeNode()
  const panel = fakeNode()
  let closed = 0
  const onPointerDown = backdropPointerDownHandler(() => { closed += 1 })

  onPointerDown({ target: panel, currentTarget: overlay })
  assert.equal(closed, 0, '点面板内部不应关闭')
  onPointerDown({ target: overlay, currentTarget: overlay })
  assert.equal(closed, 1, '点遮罩空白处应关闭')
})

test('所有弹层统一改用共用关闭模块，不再依赖重复点击触发按钮', async () => {
  const read = (relative) => readFile(join(projectRoot, relative), 'utf8')
  const [slot, git, account, fileDom, subscription, archive] = await Promise.all([
    read('src/client/cli-slots.ts'),
    read('src/client/git-management.ts'),
    read('src/client/account-bar.ts'),
    read('src/client/file-management-dom.ts'),
    read('src/client/subscription-slot.ts'),
    read('src/client/workspace-session-archive-dom.ts'),
  ])

  // Agent 与模型两个选择器都绑定根节点并注册外部关闭。
  assert.match(slot, /import \{ useDismissOnOutsidePointer \} from '\.\/popup-dismiss\.js'/u)
  assert.equal([...slot.matchAll(/useDismissOnOutsidePointer\(rootRef, open,/gu)].length, 2)
  assert.equal([...slot.matchAll(/ref: rootRef/gu)].length, 2)
  assert.doesNotMatch(slot, /event\.target instanceof Node/u)

  // Git 的两个「⋯」菜单从原生 details 折叠改为受控菜单。
  assert.match(git, /useDismissOnOutsidePointer\(rootRef, open, \(\) => setOpen\(false\)\)/u)
  assert.match(git, /useDismissOnOutsidePointer\(menuRef, menuOpen, \(\) => setMenuOpen\(false\)\)/u)
  assert.doesNotMatch(git, /createElement\('summary', \{ style: menuSummaryStyle/u)
  assert.doesNotMatch(git, /createElement\('details', \{ style: menuStyle/u)
  // 保留变更树目录的原生折叠，客户端包仍需要 details/summary 标记。
  assert.match(git, /createElement\('details', \{ key: `dir:/u)
  assert.match(git, /backdropPointerDownHandler\(onClose\)/u)

  // DOM 账户菜单：监听与菜单同生共死，Esc 由共用模块提供。
  assert.match(account, /import \{ attachOutsideDismissal \} from '\.\/popup-dismiss\.js'/u)
  assert.match(account, /closeMenuDismiss = attachOutsideDismissal\(root, \(\) => \[menu, button\], closeMenu\)/u)
  assert.doesNotMatch(account, /closeMenuListener/u)
  assert.doesNotMatch(account, /queueMicrotask\(\(\) => root\.addEventListener/u)

  // 文件树右键菜单改用 pointerdown，并且只在点到菜单之外时关闭：
  // 菜单项自身在 pointerdown 之后才收到 click，无条件关闭会让动作永远不执行。
  assert.match(fileDom, /document\.addEventListener\('pointerdown', onDocumentPointerDown, true\)/u)
  assert.match(fileDom, /isOutsideDismissRoots\(event\.target, \[menu\]\)/u)
  assert.doesNotMatch(fileDom, /onDocumentClick/u)

  // 订阅浮框迁移到共用 hook 后不再自带 pointerdown/Escape 监听。
  assert.match(subscription, /useDismissOnOutsidePointer\(rootRef, open, \(\) => setOpen\(false\)\)/u)
  assert.doesNotMatch(subscription, /document\.addEventListener\('pointerdown'/u)

  // 归档模态框的遮罩同样按 pointerdown 关闭。
  assert.match(archive, /overlay\.addEventListener\('pointerdown', \(event\) => \{ if \(event\.target === overlay\) closeArchiveModal\(dom\) \}\)/u)
})

test('显式关闭按钮的弹窗补齐点击遮罩关闭', async () => {
  const read = (relative) => readFile(join(projectRoot, relative), 'utf8')
  const sources = await Promise.all([
    read('src/client/features/cli-adapters.ts'),
    read('src/client/features/reverse-proxy-panel.ts'),
    read('src/client/debug/ui.ts'),
  ])

  for (const source of sources) {
    assert.match(source, /import \{ backdropPointerDownHandler \} from '[^']*popup-dismiss\.js'/u)
    assert.match(source, /onPointerDown: backdropPointerDownHandler\(/u)
  }

  // 遮罩改为 presentation，语义角色落在真正的对话框面板上。
  assert.match(sources[0]!, /role: 'presentation',\n\s+onPointerDown: backdropPointerDownHandler\(onClose\),/u)
  assert.match(sources[1]!, /role: 'presentation', onPointerDown: backdropPointerDownHandler\(\(\) => \{ setAddAddressOpen\(false\); setAddressError\(''\) \}\)/u)
  assert.match(sources[2]!, /role: 'presentation', onPointerDown: backdropPointerDownHandler\(\(\) => setDraft\(null\)\)/u)
})
