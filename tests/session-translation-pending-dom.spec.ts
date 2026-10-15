import assert from 'node:assert/strict'
import test from 'node:test'
import { watchPendingTranslationTargets, type PendingTranslationTarget } from '../src/client/session-translation-pending-dom.js'
import { registerSessionTranslationChatUi } from '../src/client/session-translation-chat.js'
import { setNativeTranslationDefaultReader } from '../src/client/native-translation-default.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import type { ReactElement } from 'react'
import type { CodingNsClientServices } from '../src/client/features/types.js'

class FakeObserver {
  static current: FakeObserver
  connected = false
  readonly callback: () => void
  constructor(callback: () => void) { this.callback = callback; FakeObserver.current = this }
  observe() { this.connected = true }
  disconnect() { this.connected = false }
  flush() { if (this.connected) this.callback() }
}

class Element {
  readonly nodeType = 1
  readonly children: Element[] = []
  parentElement: Element | null = null
  readonly dataset: Record<string, string> = {}
  readonly style: Record<string, string> = {}
  readonly ownerDocument = document
  readonly selector: string
  textContent: string
  constructor(selector: string, textContent = '') { this.selector = selector; this.textContent = textContent }
  append(child: Element) { this.insertBefore(child, null) }
  insertBefore(child: Element, before: Element | null) {
    assert.ok(before === null || this.children.includes(before), 'insertBefore must use a direct child')
    child.parentElement = this
    this.children.splice(before === null ? this.children.length : this.children.indexOf(before), 0, child)
  }
  remove() {
    if (this.parentElement !== null) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1)
    this.parentElement = null
  }
  closest(selector: string): Element | null { return this.selector === selector ? this : this.parentElement?.closest(selector) ?? null }
  contains(child: Element): boolean { return child === this || this.children.some((item) => item.contains(child)) }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [...(child.selector === selector ? [child] : []), ...child.querySelectorAll(selector)])
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null }
}

const document = {
  defaultView: { MutationObserver: FakeObserver },
  createElement: (tag: string) => new Element(tag),
}

function pending(text = 'Translate this message') {
  const row = new Element('[data-submission-echo]')
  const bubble = new Element('[class*="bubble"]', text)
  const actions = new Element('[data-clock="start"]')
  const tooltip = new Element('tooltip')
  const copy = new Element('button')
  tooltip.append(copy)
  actions.append(tooltip)
  row.append(bubble)
  row.append(actions)
  return { row, bubble, actions, tooltip }
}

test('pending action attaches immediately before copy, survives updates, and retires with its message', () => {
  const root = new Element('[data-conversation-session]')
  const anchor = new Element('anchor')
  root.append(anchor)
  const first = pending()
  root.append(first.row)
  let targets: readonly PendingTranslationTarget[] = []
  let changes = 0
  const stop = watchPendingTranslationTargets(anchor as unknown as HTMLElement, (next) => { targets = next; changes++ })
  assert.equal(targets.length, 1)
  assert.equal(targets[0]!.original, 'Translate this message')
  assert.equal(first.actions.children[0], targets[0]!.container)
  assert.equal(first.actions.children[1], first.tooltip)
  const originalContainer = targets[0]!.container
  FakeObserver.current.flush()
  assert.equal(changes, 1, 'rendering the portal must not create an observer loop')
  first.bubble.textContent = 'Updated input'
  FakeObserver.current.flush()
  assert.equal(targets[0]!.container, originalContainer)
  assert.equal(targets[0]!.original, 'Updated input')

  const second = pending('Second input')
  root.append(second.row)
  FakeObserver.current.flush()
  assert.equal(targets.length, 2)
  const secondKey = targets[1]!.key
  first.row.remove()
  FakeObserver.current.flush()
  assert.equal(targets.length, 1)
  assert.equal(targets[0]!.key, secondKey)
  assert.equal(first.actions.children.length, 1, 'completed or canceled messages release their pending action')
  stop()
  assert.equal(second.actions.children.length, 1)
  assert.equal(FakeObserver.current.connected, false)
})

test('pending actions stay in their session and ignore historical, nested, and attachment-only messages', () => {
  const root = new Element('[data-conversation-session]')
  const anchor = new Element('anchor')
  root.append(anchor)
  const empty = pending('  ')
  root.append(empty.row)
  const nested = new Element('[data-conversation-session]')
  const other = pending('Another session')
  nested.append(other.row)
  root.append(nested)
  const history = new Element('user-message')
  history.append(new Element('[class*="bubble"]', 'Old message'))
  history.append(new Element('[data-clock="start"]'))
  root.append(history)
  let targets: readonly PendingTranslationTarget[] = []
  const stop = watchPendingTranslationTargets(anchor as unknown as HTMLElement, (next) => { targets = next })
  assert.equal(targets.length, 0)
  assert.equal(empty.actions.children.length, 1)
  assert.equal(other.actions.children.length, 1)
  const current = pending('New input')
  root.append(current.row)
  FakeObserver.current.flush()
  assert.equal(targets.length, 1)
  assert.equal(targets[0]!.original, 'New input')
  stop()
})

test('queue submission previews support an attached action with or without a native action row', () => {
  const root = new Element('[data-conversation-session]')
  const anchor = new Element('anchor')
  root.append(anchor)
  const row = new Element('[data-submission-echo]')
  row.append(new Element('[class*="preview"]', 'Queued message'))
  root.append(row)
  let targets: readonly PendingTranslationTarget[] = []
  const stop = watchPendingTranslationTargets(anchor as unknown as HTMLElement, next => { targets = next })
  assert.equal(targets[0]!.container.parentElement, row)
  assert.equal(targets[0]!.original, 'Queued message')
  stop()
  const actions = new Element('[class*="actions"]')
  row.append(actions)
  const stopWithActions = watchPendingTranslationTargets(anchor as unknown as HTMLElement, next => { targets = next })
  assert.equal(targets[0]!.container.parentElement, actions)
  stopWithActions()
})

test('failure polling attaches the prompt to the matching pending user message and refreshes after a choice', async () => {
  const registered = new Map<string, (props: any) => ReactElement>()
  let failures = [{ id: 'failed-second-message', sessionId: 'failure-attachment', record: {
    original: 'Second message', translated: 'Second message', targetLanguage: 'en', bilingual: false, failed: true,
  } }]
  const services = {
    settings: { getSnapshot: () => ({ value: undefined }), subscribe: () => () => undefined },
    rpc: { async call(_channel: string, endpoint: string) { return { ok: true, value: endpoint === 'cli/translation/pending' ? failures : { adapterId: 'dsh', translationEnabled: true } } } },
    locale: { bind: () => resolveCodingNsTranslator() },
    slots: {
      inject(_name: string, callback: () => () => void) { return callback() },
      register(options: any, component: (props: any) => ReactElement) { registered.set(options.id ?? options.key, component); return () => {} },
    },
  } as unknown as CodingNsClientServices
  const remove = registerSessionTranslationChatUi(services)
  const root = new Element('[data-conversation-session]')
  const anchor = new Element('anchor')
  root.append(anchor)
  const first = pending('First message')
  const second = pending('Second message')
  root.append(first.row); root.append(second.row)
  const renderer = createHookRenderer(registered.get('codingns-translation-pending')!, {
    services, translationT: resolveCodingNsTranslator(), sessionId: 'failure-attachment',
  })
  const flush = () => new Promise<void>(resolve => setImmediate(resolve))
  try {
    const tree = renderer.render()
    ;(tree as any).ref.current = anchor
    await flush(); renderer.render(); await flush()
    const portals = (renderer.render().props as any).children
    assert.equal(portals.length, 2)
    assert.equal(portals[0].children.props.inputFailure, undefined)
    assert.equal(portals[1].containerInfo, second.actions.children[0])
    assert.equal(portals[1].children.props.inputFailure.id, failures[0]!.id)
    failures = []
    portals[1].children.props.onDecision()
    await flush()
    assert.equal((renderer.render().props as any).children[1].children.props.inputFailure, undefined)
  } finally { renderer.dispose(); remove() }
})

test('the registered pending slot renders portals only for enabled sessions and releases them on disable or unmount', async () => {
  const registered = new Map<string, (props: any) => ReactElement>()
  let inputEnabled = true
  const services = {
    settings: { getSnapshot: () => ({ value: { sessionTranslation: { inputEnabled } } }), subscribe: () => () => undefined },
    rpc: { async call() { return { ok: true, value: { adapterId: 'dsh' } } } },
    locale: { bind: () => resolveCodingNsTranslator() },
    slots: {
      inject(_name: string, callback: () => () => void) { return callback() },
      register(options: any, component: (props: any) => ReactElement) {
        const key = options.key ?? options.id
        registered.set(key, component)
        return () => registered.delete(key)
      },
    },
  } as unknown as CodingNsClientServices
  setNativeTranslationDefaultReader(() => false)
  const remove = registerSessionTranslationChatUi(services)
  const root = new Element('[data-conversation-session]')
  const anchor = new Element('anchor')
  root.append(anchor)
  const message = pending()
  root.append(message.row)
  let subagent: unknown = null
  const props = {
    services, translationT: resolveCodingNsTranslator(), sessionId: 'pending-slot-lifecycle',
    useSession: (selector: (state: { subagent: unknown }) => unknown) => selector({ subagent }),
  }
  const renderer = createHookRenderer(registered.get('codingns-translation-pending')!, props)
  try {
    let tree = renderer.render()
    ;(tree as any).ref.current = anchor
    await new Promise<void>((resolve) => setImmediate(resolve))
    tree = renderer.render()
    assert.equal(message.actions.children.length, 1)
    setNativeTranslationDefaultReader(() => true)
    tree = renderer.render()
    const portal = (tree.props as any).children
    assert.equal(portal.containerInfo, message.actions.children[0])
    assert.equal(portal.children.props.original, 'Translate this message')
    assert.equal(portal.children.props.record, undefined)
    inputEnabled = false
    renderer.render()
    assert.equal(message.actions.children.length, 1)
    inputEnabled = true
    renderer.render()
    assert.equal(message.actions.children.length, 2)
    subagent = { address: { mode: 'continuable' } }
    renderer.render()
    assert.equal(message.actions.children.length, 1)
    subagent = null
    renderer.render()
    assert.equal(message.actions.children.length, 2)
    setNativeTranslationDefaultReader(() => false)
    renderer.render()
    assert.equal(message.actions.children.length, 1)
    setNativeTranslationDefaultReader(() => true)
    renderer.render()
  } finally {
    renderer.dispose()
    remove()
    setNativeTranslationDefaultReader(undefined)
  }
  assert.equal(message.actions.children.length, 1)
  assert.equal(FakeObserver.current.connected, false)
  assert.equal(registered.size, 0)
})
