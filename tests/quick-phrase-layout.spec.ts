import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyQuickPhraseOrder,
  matchesDshCssModuleClass,
  QUICK_PHRASE_FALLBACK_MARGIN,
  QUICK_PHRASE_GAP_SCALE,
  QUICK_PHRASE_PERMISSION_ORDER,
  QUICK_PHRASE_TRIGGER_ORDER,
  readQuickPhraseMargin,
} from '../data/build/dist/client/quick-phrase-layout.js'

/**
 * 复刻 DSH 输入工具栏：添加附件按钮、隐藏的文件输入、权限/规划组，最后是
 * conversation.input.left 槽位（锚点 display: contents，不生成盒子）。
 */
function createToolbar() {
  const tools = new FakeElement('div')
  tools.display = 'flex'
  tools.columnGap = '12px'
  const addButton = new FakeElement('button')
  const addWrapper = new FakeElement('span')
  addWrapper.append(addButton)
  const fileInput = new FakeElement('input')
  fileInput.display = 'none'
  const permissionGroup = new FakeElement('div')
  permissionGroup.append(new FakeElement('button'))
  const slotAnchor = new FakeElement('div')
  slotAnchor.display = 'contents'
  const trigger = new FakeElement('div')
  slotAnchor.append(trigger)
  tools.append(addWrapper, fileInput, permissionGroup, slotAnchor)
  return { tools, addButton, fileInput, permissionGroup, slotAnchor, trigger }
}

const fakeComputedStyle = (element) => ({ display: element.display ?? 'block', columnGap: element.columnGap })

test('快捷短语排在权限组件之前，销毁时还原权限组原有的 order', () => {
  const { addButton, permissionGroup, trigger } = createToolbar()
  // 添加按钮没有 order（0），快捷短语取 1、权限组取 2，三者顺序固定。
  assert.ok(QUICK_PHRASE_TRIGGER_ORDER < QUICK_PHRASE_PERMISSION_ORDER)
  permissionGroup.style.order = '3'

  const order = applyQuickPhraseOrder({ trigger, addButton }, { computedStyle: fakeComputedStyle })
  assert.deepEqual(order.reordered, [permissionGroup])
  assert.equal(permissionGroup.style.order, String(QUICK_PHRASE_PERMISSION_ORDER))

  order.dispose()
  assert.equal(permissionGroup.style.order, '3')
})

test('穿透槽位锚点、跳过隐藏节点，只重排添加按钮与快捷短语之间的控件', () => {
  const { tools, addButton, fileInput, permissionGroup, trigger } = createToolbar()
  const order = applyQuickPhraseOrder({ trigger, addButton }, { computedStyle: fakeComputedStyle })

  assert.equal(order.container, tools)
  assert.equal(fileInput.style.order, undefined)
  assert.equal(trigger.style.order, undefined)
  assert.deepEqual(order.reordered, [permissionGroup])
})

test('快捷短语两侧间距收到宿主 gap 的一半', () => {
  assert.equal(QUICK_PHRASE_GAP_SCALE, 0.5)
  const { tools } = createToolbar()
  assert.equal(readQuickPhraseMargin(tools, { computedStyle: fakeComputedStyle }), -6)

  // 窄容器下 DSH 的容器查询把 gap 压到 8px，负外边距同步减半。
  tools.columnGap = '8px'
  assert.equal(readQuickPhraseMargin(tools, { computedStyle: fakeComputedStyle }), -4)
})

test('读不到宿主 gap 时退回默认间距', () => {
  const { tools } = createToolbar()
  tools.columnGap = 'normal'
  assert.equal(readQuickPhraseMargin(tools, { computedStyle: fakeComputedStyle }), QUICK_PHRASE_FALLBACK_MARGIN)
  assert.equal(readQuickPhraseMargin(null, { computedStyle: fakeComputedStyle }), QUICK_PHRASE_FALLBACK_MARGIN)
})

test('工具栏结构变化时不改宿主布局', () => {
  const flat = new FakeElement('div')
  flat.display = 'flex'
  const addButton = new FakeElement('button')
  const trigger = new FakeElement('div')
  flat.append(addButton, trigger)
  const order = applyQuickPhraseOrder({ trigger, addButton }, { computedStyle: fakeComputedStyle })
  assert.deepEqual(order.reordered, [])
  assert.equal(addButton.style.order, undefined)

  const loose = new FakeElement('div')
  const detachedTrigger = new FakeElement('div')
  loose.append(new FakeElement('button'), detachedTrigger)
  const looseOrder = applyQuickPhraseOrder({ trigger: detachedTrigger, addButton: new FakeElement('button') }, { computedStyle: fakeComputedStyle })
  assert.deepEqual(looseOrder.reordered, [])
  looseOrder.dispose()
})

test('添加附件按钮按 CSS Modules 本地名匹配，兼容两种构建的哈希前缀', () => {
  // npm 分发的 Web 构建是 uV2eYG_*，Desktop 内嵌构建（app.asar）是 yhfFVG_*。
  assert.equal(matchesDshCssModuleClass('uV2eYG_add', 'add'), true)
  assert.equal(matchesDshCssModuleClass('yhfFVG_add', 'add'), true)
  assert.equal(matchesDshCssModuleClass('uV2eYG_add uV2eYG_primary', 'add'), true)
  assert.equal(matchesDshCssModuleClass('_3e4SsG_trailing', 'trailing'), true)
  // 只认完整类名，不做子串匹配。
  assert.equal(matchesDshCssModuleClass('uV2eYG_addFiles', 'add'), false)
  assert.equal(matchesDshCssModuleClass('uV2eYG_addition', 'add'), false)
  // 没有哈希前缀的类名不是 CSS Modules 类名。
  assert.equal(matchesDshCssModuleClass('add', 'add'), false)
  assert.equal(matchesDshCssModuleClass('codingns4dsh-agent-trigger', 'add'), false)
  assert.equal(matchesDshCssModuleClass(null, 'add'), false)
  assert.equal(matchesDshCssModuleClass(undefined, 'add'), false)
})

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentElement = null
    this.style = {}
    this.display = undefined
    this.columnGap = undefined
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this
      this.children.push(child)
    }
  }
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node))
  }
}
