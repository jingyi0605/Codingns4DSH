import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidElement } from 'react'
import type { ReactElement } from 'react'
import { AssistantNotificationBubble, assistantNotificationIsVisible } from '../src/client/avatar/notification-bubble.js'
import type { AssistantNotificationBubbleProps } from '../src/client/avatar/notification-bubble.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  return isValidElement(node) ? [node, ...elements((node.props as any).children)] : []
}

/** 仅回放 DOM 可见性协议，不启动浏览器或原生窗口。 */
function fixture() {
  const dom = Object.assign(new EventTarget(), { visibilityState: 'visible', defaultView: Object.assign(new EventTarget(), {
    innerWidth: 1000, innerHeight: 800, getComputedStyle: (node: any) => node.style,
  }) })
  const element = (rect: { left: number; right: number; top: number; bottom: number }, parentElement: any = null) => ({
    ownerDocument: dom, isConnected: true, parentElement, rect,
    style: { visibility: 'visible', display: 'block', opacity: '1', overflow: 'visible', overflowX: 'visible', overflowY: 'visible' },
    getBoundingClientRect() { return this.rect }, getClientRects() { return [this.rect] },
  })
  const parent = element({ left: 0, right: 320, top: 0, bottom: 0 })
  parent.style.overflowY = 'auto'
  const node = element({ left: 10, right: 310, top: 10, bottom: 150 }, parent)
  return { dom, parent, node }
}

test('完全裁切、祖先透明和零面积气泡不算首展，部分可读气泡可以确认', () => {
  const f = fixture(), node = f.node as unknown as HTMLElement
  assert.equal(assistantNotificationIsVisible(node), false)
  f.parent.rect.bottom = 160
  assert.equal(assistantNotificationIsVisible(node), true)
  f.parent.style.opacity = '0'; assert.equal(assistantNotificationIsVisible(node), false)
  f.parent.style.opacity = '1'; f.parent.rect.bottom = 20
  assert.equal(assistantNotificationIsVisible(node), true)
  f.node.rect.right = f.node.rect.left
  assert.equal(assistantNotificationIsVisible(node), false)
})

test('主气泡滚动进入裁切区后才首展；隐藏窗口、通知升级和卸载正确隔离确认', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')
  let observerCallback: (() => void) | undefined, disconnected = 0
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: class {
    constructor(callback: () => void) { observerCallback = callback }
    observe() {}
    disconnect() { disconnected++ }
  } })
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'IntersectionObserver', descriptor); else delete (globalThis as any).IntersectionObserver })
  const f = fixture(), presented: Array<[string, number, string | undefined]> = []
  const props: AssistantNotificationBubbleProps = {
    frame: { generation: 7, noticeId: 'same-turn', kind: 'completed', hostLabel: '本机', workspaceLabel: '项目', sessionTitle: '会话', text: '本轮已完成', availability: 'ready' },
    t: resolveCodingNsTranslator(), onOpen() {}, onDismiss() {},
    onPresented(id, generation, kind) { presented.push([id, generation, kind]) },
  }
  const renderer = createHookRenderer((value: AssistantNotificationBubbleProps) => {
    const output = AssistantNotificationBubble(value)
    // 给组件公开的主气泡 ref 挂入替身节点，之后 Hook 效果按真实顺序运行。
    const main = (output.props.children as ReactElement[]).find((child) => child?.props?.role === 'status') as any
    if (main?.ref) main.ref.current = f.node
    return output
  }, props)
  t.after(() => renderer.dispose())
  renderer.render(); t.mock.timers.tick(0)
  assert.deepEqual(presented, [])
  f.parent.rect.bottom = 200; f.dom.visibilityState = 'hidden'; observerCallback!()
  assert.deepEqual(presented, [])
  f.dom.visibilityState = 'visible'; f.dom.dispatchEvent(new Event('scroll'))
  assert.deepEqual(presented, [['same-turn', 7, 'completed']])
  observerCallback!(); f.dom.dispatchEvent(new Event('visibilitychange'))
  assert.equal(presented.length, 1)
  renderer.render({ ...props, frame: { ...props.frame, kind: 'error' } as typeof props.frame }); t.mock.timers.tick(0)
  assert.deepEqual(presented.at(-1), ['same-turn', 7, 'error'])
  renderer.dispose(); f.dom.dispatchEvent(new Event('scroll'))
  assert.equal(presented.length, 2); assert.ok(disconnected >= 2)
})

test('通知自动关闭只从真实首展开始计时，并通过自动收起保留记录', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(), presented: string[] = [], dismissed: string[] = []
  const props: AssistantNotificationBubbleProps = {
    frame: { generation: 3, noticeId: 'auto-close', kind: 'completed', hostLabel: '本机', workspaceLabel: '项目', sessionTitle: '会话', text: '已完成', availability: 'ready' },
    t: resolveCodingNsTranslator(), autoClose: true, autoCloseSeconds: 15,
    onOpen() {}, onDismiss(id) { dismissed.push(id) }, onPresented(id) { presented.push(id) },
  }
  const renderer = createHookRenderer((value: AssistantNotificationBubbleProps) => {
    const output = AssistantNotificationBubble(value)
    const main = (output.props.children as ReactElement[]).find((child) => child?.props?.role === 'status') as any
    if (main?.ref) main.ref.current = f.node
    return output
  }, props)
  t.after(() => renderer.dispose())
  renderer.render(); t.mock.timers.tick(0)
  assert.deepEqual(presented, []); assert.deepEqual(dismissed, [])
  f.parent.rect.bottom = 200; f.dom.dispatchEvent(new Event('scroll'))
  assert.deepEqual(presented, ['auto-close'])
  t.mock.timers.tick(14_999); assert.deepEqual(dismissed, [])
  t.mock.timers.tick(1); assert.deepEqual(dismissed, ['auto-close'])
})

test('单条通知的垃圾桶按钮仍然保留，并把被点击通知身份回传给清理回调', () => {
  const dismissed: Array<[string, number, number | undefined]> = []
  const props: AssistantNotificationBubbleProps = {
    frame: { generation: 3, revision: 1, serverNow: 1, primary: {
      noticeId: 'notice-to-clear', kind: 'completed', hostLabel: '本机', workspaceLabel: '项目', sessionTitle: '会话', text: '已完成',
      createdAt: 1, read: false, presentation: 'queued', lifecycle: 'resolved', availability: 'ready',
    }, items: [], unreadCount: 1, pendingCount: 0, cursor: null }, t: resolveCodingNsTranslator(), onOpen() {},
    onDismiss(id, generation, connectionGeneration) { dismissed.push([id, generation, connectionGeneration]) }, onPresented() {},
  }
  const renderer = createHookRenderer(AssistantNotificationBubble, props)
  try {
    const tree = renderer.render()
    const button = elements(tree).find((element) => element.props['data-codingns-notification-action'] === 'dismiss')
    assert.ok(button)
    button!.props.onClick()
    assert.deepEqual(dismissed, [['notice-to-clear', 3, undefined]])
  } finally { renderer.dispose() }
})

test('安全列表保留已读待办、隐藏已读终态，并显示空提示与明确会话操作标签', () => {
  const base = { hostLabel: '远端设备', workspaceLabel: '项目', sessionTitle: '同名会话', text: '需要查看', createdAt: 1,
    read: true, presentation: 'collapsed' as const, lifecycle: 'active' as const, availability: 'ready' as const }
  const done = { ...base, noticeId: 'done', kind: 'completed' as const }
  const pending = { ...base, noticeId: 'pending', kind: 'question' as const, connectionGeneration: 6 }
  const pendingTwo = { ...base, noticeId: 'pending-two', kind: 'approval' as const, connectionGeneration: 7 }
  const opened: unknown[][] = [], expanded: boolean[] = []
  const props: AssistantNotificationBubbleProps = { frame: { generation: 7, revision: 3, serverNow: 1000, primary: null,
    items: [done, pending, pendingTwo], unreadCount: 0, pendingCount: 2, cursor: null }, t: resolveCodingNsTranslator(),
    onOpen(...identity) { opened.push(identity) }, onDismiss() {}, onPresented() {}, onExpandedChange(value) { expanded.push(value) } }
  const renderer = createHookRenderer(AssistantNotificationBubble, props)
  try {
    let tree = renderer.render()
    elements(tree).find((element) => element.props['aria-label'] === '筛选待处理通知：2 项待处理')!.props.onClick()
    tree = renderer.render()
    assert.deepEqual(elements(tree).filter((element) => element.type === 'section').map((element) => element.props['data-codingns-notice-id']), ['pending', 'pending-two'])
    const open = elements(tree).find((element) => element.props['data-codingns-notification-action'] === 'open')!
    assert.ok(open.props['aria-label'].includes('远端设备')); assert.ok(open.props['aria-label'].includes('同名会话'))
    open.props.onClick(); assert.deepEqual(opened, [['pending', 7, 6]])
    tree = renderer.render({ ...props, frame: { ...(props.frame as any), items: [done], pendingCount: 0 } })
    assert.ok(elements(tree).some((element) => element.type === 'p' && element.props.children === props.t('awb.notifications.empty')))
    assert.deepEqual(expanded, [false, true])
  } finally { renderer.dispose() }
})

test('未读与待处理标签分别筛选对应通知，并可再次点击取消筛选', () => {
  const base = { hostLabel: '本机', workspaceLabel: '项目', sessionTitle: '会话', text: '提醒', createdAt: 1,
    presentation: 'collapsed' as const, availability: 'ready' as const }
  const unread = { ...base, noticeId: 'unread', kind: 'error' as const, read: false, lifecycle: 'resolved' as const }
  const unreadPending = { ...base, noticeId: 'unread-pending', kind: 'question' as const, read: false, lifecycle: 'active' as const }
  const readPending = { ...base, noticeId: 'read-pending', kind: 'approval' as const, read: true, lifecycle: 'active' as const }
  const props: AssistantNotificationBubbleProps = { frame: { generation: 2, revision: 1, serverNow: 1, primary: null,
    items: [unread, unreadPending, readPending], unreadCount: 2, pendingCount: 2, cursor: null }, t: resolveCodingNsTranslator(),
    onOpen() {}, onDismiss() {}, onPresented() {} }
  const renderer = createHookRenderer(AssistantNotificationBubble, props)
  try {
    let tree = renderer.render()
    const unreadFilter = elements(tree).find((element) => element.props['aria-label'] === '筛选未读通知：2 条未读')!
    unreadFilter.props.onClick(); tree = renderer.render()
    assert.equal(elements(tree).find((element) => element.props['aria-label'] === '筛选未读通知：2 条未读')!.props['aria-pressed'], true)
    assert.deepEqual(elements(tree).filter((element) => element.type === 'section').map((element) => element.props['data-codingns-notice-id']), ['unread'])
    assert.ok(!JSON.stringify(tree).includes('关闭提醒列表'))
    assert.ok(!JSON.stringify(tree).includes('上一页'))
    assert.ok(!JSON.stringify(tree).includes('下一页'))

    let pendingFilter = elements(tree).find((element) => element.props['aria-label'] === '筛选待处理通知：2 项待处理')!
    pendingFilter.props.onClick(); tree = renderer.render()
    assert.deepEqual(elements(tree).filter((element) => element.type === 'section').map((element) => element.props['data-codingns-notice-id']), ['unread-pending', 'read-pending'])
    assert.equal(elements(tree).find((element) => element.props['aria-label'] === '筛选待处理通知：2 项待处理')!.props['aria-pressed'], true)

    pendingFilter = elements(tree).find((element) => element.props['aria-label'] === '筛选待处理通知：2 项待处理')!
    pendingFilter.props.onClick(); tree = renderer.render()
    assert.equal(elements(tree).find((element) => element.props['aria-label'] === '筛选待处理通知：2 项待处理')!.props['aria-pressed'], false)
    assert.deepEqual(elements(tree).filter((element) => element.type === 'section').map((element) => element.props['data-codingns-notice-id']), ['unread', 'unread-pending', 'read-pending'])
    assert.ok(!JSON.stringify(tree).includes('关闭提醒列表'))
    assert.ok(!JSON.stringify(tree).includes('上一页'))
    assert.ok(!JSON.stringify(tree).includes('下一页'))
  } finally { renderer.dispose() }
})

test('收起通知只保留展开按钮和数量徽标，再次展开仍显示完整记录', () => {
  const collapsed: boolean[] = []
  const props: AssistantNotificationBubbleProps = { frame: {
    generation: 4, revision: 1, serverNow: 1, primary: {
      noticeId: 'pending', kind: 'question', hostLabel: '本机', workspaceLabel: '项目', sessionTitle: '需要处理的会话', text: '请处理',
      createdAt: 1, read: false, presentation: 'queued', lifecycle: 'active', availability: 'ready',
    }, items: [], unreadCount: 16, pendingCount: 2, cursor: null,
  }, t: resolveCodingNsTranslator(), onOpen() {}, onDismiss() {}, onPresented() {}, onCollapsedChange(value) { collapsed.push(value) } }
  const renderer = createHookRenderer(AssistantNotificationBubble, props)
  try {
    let tree = renderer.render()
    elements(tree).find((element) => element.props['aria-label'] === '收起通知')!.props.onClick()
    tree = renderer.render()
    assert.ok(elements(tree).some((element) => element.props['aria-label'] === '展开通知'))
    assert.ok(elements(tree).some((element) => element.props['aria-label'] === '筛选未读通知：16 条未读'))
    assert.ok(elements(tree).some((element) => element.props['aria-label'] === '筛选待处理通知：2 项待处理'))
    assert.equal(elements(tree).find((element) => element.props['data-codingns-notification-toolbar'] === true)!.props.style.justifyContent, 'center')
    assert.equal(elements(tree).filter((element) => element.type === 'section').length, 0)
    assert.ok(!JSON.stringify(tree).includes('需要处理的会话'))
    elements(tree).find((element) => element.props['aria-label'] === '展开通知')!.props.onClick()
    tree = renderer.render()
    assert.equal(elements(tree).filter((element) => element.type === 'section').length, 1)
    assert.deepEqual(collapsed, [true, false])
  } finally { renderer.dispose() }
})

test('单条通知也显示筛选按钮，已读记录不会因首页筛选条件在展开后丢失', () => {
  const completed = { noticeId: 'completed', kind: 'completed' as const, hostLabel: '本机', workspaceLabel: '项目', sessionTitle: '已完成会话', text: '已完成',
    createdAt: 1, read: true, presentation: 'collapsed' as const, lifecycle: 'resolved' as const, availability: 'ready' as const }
  const pending = { noticeId: 'pending', kind: 'question' as const, hostLabel: '本机', workspaceLabel: '项目', sessionTitle: '待处理会话', text: '请处理',
    createdAt: 2, read: false, presentation: 'queued' as const, lifecycle: 'active' as const, availability: 'ready' as const }
  const props: AssistantNotificationBubbleProps = { frame: { generation: 1, revision: 1, serverNow: 1, primary: pending,
    items: [pending, completed], unreadCount: 0, pendingCount: 1, cursor: null }, t: resolveCodingNsTranslator(), onOpen() {}, onDismiss() {}, onPresented() {} }
  const renderer = createHookRenderer(AssistantNotificationBubble, props)
  try {
    let tree = renderer.render()
    assert.ok(elements(tree).some((element) => element.props['aria-label'] === '筛选待处理通知：1 项待处理'))
    assert.equal(elements(tree).find((element) => element.props['data-codingns-notification-toolbar'] === true)!.props.style.flexWrap, 'nowrap')
    elements(tree).find((element) => element.props['aria-label'] === '收起通知')!.props.onClick()
    tree = renderer.render()
    elements(tree).find((element) => element.props['aria-label'] === '展开通知')!.props.onClick()
    tree = renderer.render()
    assert.deepEqual(elements(tree).filter((element) => element.type === 'section').map((element) => element.props['data-codingns-notice-id']), ['pending', 'completed'])
  } finally { renderer.dispose() }
})
