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

test('通知自动关闭只从真实首展开始计时，并通过收起动作保留记录', (t) => {
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

test('安全列表保留已读待办、隐藏已读终态，并显示当前页空提示与明确会话操作标签', () => {
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
    elements(tree).find((element) => element.props['aria-expanded'] === false)!.props.onClick()
    tree = renderer.render()
    assert.deepEqual(elements(tree).filter((element) => element.type === 'section').map((element) => element.props['data-codingns-notice-id']), ['pending', 'pending-two'])
    const open = elements(tree).find((element) => element.type === 'button' && element.props.children === props.t('awb.notifications.open'))!
    assert.ok(open.props['aria-label'].includes('远端设备')); assert.ok(open.props['aria-label'].includes('同名会话'))
    open.props.onClick(); assert.deepEqual(opened, [['pending', 7, 6]])
    tree = renderer.render({ ...props, frame: { ...(props.frame as any), items: [done], pendingCount: 0 } })
    assert.ok(elements(tree).some((element) => element.type === 'p' && element.props.children === props.t('awb.notifications.empty')))
    elements(tree).find((element) => element.type === 'button' && element.props.children === props.t('awb.notifications.closeList'))!.props.onClick()
    renderer.render(); assert.deepEqual(expanded, [false, true, false])
  } finally { renderer.dispose() }
})
