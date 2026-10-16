import assert from 'node:assert/strict'
import test from 'node:test'
import { useSidebarFooterAlignment } from '../src/client/sidebar-footer-style.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

test('footer controls follow native account insets, late mounting and sidebar width changes', t => {
  const previous = ['MutationObserver', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  const observers: Observer[] = []
  class Observer {
    nodes = new Set<unknown>()
    disconnected = false
    readonly update: () => void
    constructor(update: () => void) { this.update = update; observers.push(this) }
    observe(node: unknown) { this.nodes.add(node) }
    unobserve(node: unknown) { this.nodes.delete(node) }
    disconnect() { this.nodes.clear(); this.disconnected = true }
  }
  Object.assign(globalThis, { MutationObserver: Observer, ResizeObserver: Observer })
  t.after(() => { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  } })
  const variables = new Map<string, string>()
  const listeners = new Map<string, () => void>()
  let account: unknown = null
  let railRight = 260
  let accountRight = 254
  const button = { getClientRects: () => [1], getBoundingClientRect: () => ({ right: accountRight }) }
  const container = { querySelector: (selector: string) => selector === 'button[data-codingns-account-button]' ? account : {} }
  const element = { parentElement: container, ownerDocument: {
    defaultView: { addEventListener: (key: string, fn: () => void) => listeners.set(key, fn), removeEventListener: (key: string) => listeners.delete(key) },
  }, getBoundingClientRect: () => ({ right: railRight }), style: {
    setProperty: (key: string, value: string) => variables.set(key, value), removeProperty: (key: string) => variables.delete(key),
  } }
  const renderer = createHookRenderer(({ wide }: { wide: boolean }) => {
    const ref = useSidebarFooterAlignment(wide)
    ;(ref as { current: unknown }).current = element
  }, { wide: true })
  t.after(renderer.dispose)
  renderer.render()
  assert.equal(variables.size, 0, 'an absent account entry keeps the default alignment')
  account = button
  observers[1]!.update()
  assert.equal(variables.get('--codingns-quick-app-controls-end'), '6px')
  assert.ok(observers[0]!.nodes.has(button), 'a late account entry is observed for layout changes')
  accountRight = 262
  listeners.get('resize')!()
  assert.equal(variables.get('--codingns-quick-app-controls-end'), '-2px', 'native outer insets may extend beyond the quick app rail')
  railRight = 46; accountRight = 44
  renderer.render({ wide: false })
  assert.equal(variables.get('--codingns-quick-app-controls-end'), '2px')
  assert.ok(observers.slice(0, 2).every(observer => observer.disconnected))
  account = null
  observers[3]!.update()
  assert.equal(variables.size, 0)
  renderer.dispose()
  assert.ok(observers.every(observer => observer.disconnected))
  assert.equal(listeners.size, 0)
})
