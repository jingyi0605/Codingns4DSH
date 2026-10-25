import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { useState } from 'react'
import type { ReactElement, ReactPortal } from 'react'
import { MagpieContextMeter } from '../src/client/magpie-context-meter.js'
import { getMagpieContextStore } from '../src/client/magpie-context-store.js'
import type { CodingNsLocale } from '../src/client/locale.js'
import { en, zh } from '../src/client/locales/magpie.js'
import type { MagpieContextSession } from '../src/shared/contracts/magpie-management.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

class ContextElement extends EventTarget {
  readonly nodeType = 1
  readonly children: ContextElement[] = []
  readonly attributes = new Map<string, string>()
  parentElement: ContextElement | null = null
  readonly selector: string

  constructor(selector = '') { super(); this.selector = selector }
  append(child: ContextElement): void { child.parentElement = this; this.children.push(child) }
  remove(): void {
    this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1)
    this.parentElement = null
  }
  closest(selector: string): ContextElement | null {
    return this.selector === selector ? this : this.parentElement?.closest(selector) ?? null
  }
  querySelectorAll(selector: string): ContextElement[] {
    return this.children.flatMap(child => [...(child.selector === selector ? [child] : []), ...child.querySelectorAll(selector)])
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  contains(node: ContextElement): boolean { return this === node || this.children.some(child => child.contains(node)) }
  getBoundingClientRect() { return { left: 900, top: 800, width: 54, height: 24 } }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    // Node's EventTarget requires an options object to remove capture listeners.
    super.removeEventListener(type, listener, typeof options === 'boolean' ? { capture: options } : options)
  }
}

class ContextObserver {
  static instances: ContextObserver[] = []
  target: unknown
  connected = false
  readonly callback: () => void
  constructor(callback: () => void) { this.callback = callback; ContextObserver.instances.push(this) }
  observe(target: unknown): void { this.target = target; this.connected = true }
  disconnect(): void { this.connected = false }
  flush(): void { if (this.connected) this.callback() }
}

function contextValue(): MagpieContextSession {
  return {
    agent: 'codex', key: 'codex-thread', title: null, model: 'auto/model-one',
    requests: 2, turns: 1, usedTokens: 21_900, contextWindow: 500_000,
    cacheTokens: 3_000, cacheRate: 0.17, compacts: 0, latestId: 2,
    parts: [
      { kind: 'system', tokens: 1_900, items: [] },
      { kind: 'tools', tokens: 8_000, items: [] },
      { kind: 'memory', tokens: 100, items: [] },
      { kind: 'files', tokens: 900, items: [] },
      { kind: 'results', tokens: 1_000, items: [{ name: 'bash', tokens: 1_000 }] },
      { kind: 'chat', tokens: 10_000, items: [{ name: '1', tokens: 10_000 }] },
    ],
    points: [{ id: 2, time: null, tokens: 21_900, window: 500_000, cacheTokens: 3_000 }],
  }
}

function nativeContext(dock: ContextElement): ContextElement {
  const root = new ContextElement('.JObwrW_root')
  const trigger = new ContextElement('button.JObwrW_trigger')
  trigger.setAttribute('aria-expanded', 'false')
  root.append(trigger)
  dock.append(root)
  return trigger
}

function setupDom() {
  ContextObserver.instances = []
  const body = new ContextElement('body')
  const doc = Object.assign(new EventTarget(), { body, getElementById: () => ({}) })
  const win = Object.assign(new EventTarget(), { innerWidth: 1200, innerHeight: 900 })
  const restorers: Array<() => void> = []
  for (const [key, value] of Object.entries({ document: doc, window: win, MutationObserver: ContextObserver })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    restorers.push(() => {
      if (original === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, original)
    })
  }
  const dock = new ContextElement('[data-composer-dock]')
  body.append(dock)
  const slot = new ContextElement('[data-slot="codingns.grok-context.conversation.composer.dock"]')
  const entry = new ContextElement()
  const anchor = new ContextElement('[data-codingns-magpie-context-enhancer]')
  dock.append(slot)
  slot.append(entry)
  entry.append(anchor)
  return { body, doc, dock, anchor, restore: () => { for (const restore of restorers) restore() } }
}

function portalOf(output: ReactElement): ReactPortal {
  const portal = (output.props as { children?: ReactPortal }).children
  assert.ok(portal, 'clicking the native button must open the Magpie panel')
  return portal
}

function contextLocale(language: 'en' | 'zh'): CodingNsLocale {
  const dictionary = language === 'en' ? en : zh
  const snapshot = { active: language, locales: [], revision: 0 }
  return {
    bind: () => (key, params) => (dictionary[key] ?? key).replace(/\{(\w+)\}/gu,
      (slot, name) => String(params?.[name] ?? slot)),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    register: () => () => undefined,
  }
}

test('the native context button opens Magpie through the slot outlet wrapper and refreshes in place', async t => {
  const { body, doc, dock, anchor, restore } = setupDom()
  const trigger = nativeContext(dock)
  let value = contextValue()
  let pressure = { projectedTokens: 12_500, pressureTokens: 42_600, contextWindow: 1_000_000 }
  let breakdown = { systemTokens: 1_900, toolsTokens: 8_300, messageTokens: 644 }
  const locale = contextLocale('en')
  const useProjection = (key: string): unknown => {
    useState(key)
    return key === 'contextPressure' ? pressure : breakdown
  }
  const rpc = { call: async () => ({ ok: true as const, value }) }
  const store = getMagpieContextStore(rpc, 'dsh-session')
  const view = createHookRenderer(() => {
    const output = MagpieContextMeter({ rpc, sessionId: 'dsh-session', useProjection, locale })!
    ;(output as unknown as { ref: { current: ContextElement } }).ref.current = anchor
    return output
  }, {}, { checkHookOrder: true })
  t.after(() => { view.dispose(); restore() })
  view.render()
  await setImmediate()
  view.render()
  assert.ok(ContextObserver.instances[0]?.target === dock, 'watch the composer dock, outside the slot outlet wrapper')

  const click = new Event('click', { cancelable: true, bubbles: true })
  trigger.dispatchEvent(click)
  assert.equal(click.defaultPrevented, true, 'capture must prevent the native popup from also opening')
  const opened = portalOf(view.render())
  assert.equal(opened.containerInfo, body, 'the panel must escape the hidden enhancer through a portal')
  const panel = opened.children as ReactElement
  assert.equal(panel.props.className, 'codingns4dsh-magpie-context-panel')
  assert.equal(panel.props.role, 'dialog')
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  const markup = renderToStaticMarkup(panel)
  for (const expected of [/21\.9K/u, /bash/u, /auto\/model-one/u, /17%/u,
    /context-block-system/u, /context-block-tools/u, /context-block-memory/u,
    /context-block-files/u, /context-block-results/u, /context-block-chat/u]) assert.match(markup, expected)
  const summary = panel.props.children[0] as ReactElement
  assert.equal(summary.type, 'section', 'native information belongs above the Magpie details')
  assert.equal(summary.props['aria-label'], 'DSH context')
  const nativeMarkup = renderToStaticMarkup(summary)
  assert.match(nativeMarkup, /Context used 1%/u)
  assert.match(nativeMarkup, /~12\.5K \/ 1M/u, 'prefer native projectedTokens over pressureTokens and Magpie tokens')
  assert.match(nativeMarkup, /System prompt<\/dt><dd><span>~1\.9K<\/span>.*?>17\.5%<\/span>/u)
  assert.match(nativeMarkup, /Tool definitions<\/dt><dd><span>~8\.3K<\/span>.*?>76\.5%<\/span>/u)
  assert.match(nativeMarkup, /Conversation messages<\/dt><dd><span>~644<\/span>.*?>5\.9%<\/span>/u)
  assert.doesNotMatch(nativeMarkup, /21\.9K|42\.6K|500K/u)

  pressure = { ...pressure, projectedTokens: 25_000 }
  breakdown = { systemTokens: 4_000, toolsTokens: 6_000, messageTokens: 10_000 }
  const nativeRefresh = portalOf(view.render()).children as ReactElement
  assert.equal(nativeRefresh.ref, panel.ref, 'native snapshot updates must retain the open panel')
  const updatedNativeMarkup = renderToStaticMarkup(nativeRefresh.props.children[0] as ReactElement)
  assert.match(updatedNativeMarkup, /~25K \/ 1M/u)
  assert.match(updatedNativeMarkup, /Context used 3%/u)
  for (const share of ['20%', '30%', '50%']) assert.ok(updatedNativeMarkup.includes(share))
  assert.match(renderToStaticMarkup(nativeRefresh), /21\.9K/u, 'native updates must not replace the Magpie details')

  value = { ...value, usedTokens: 30_000, requests: 3 }
  await store.refresh()
  const refreshed = portalOf(view.render()).children as ReactElement
  assert.equal(refreshed.type, panel.type)
  assert.equal(refreshed.ref, panel.ref, 'refresh must retain the panel ref and open state')
  assert.match(renderToStaticMarkup(refreshed), /30K/u)
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  assert.equal(ContextObserver.instances.length, 1, 'content refresh must not detach or rebind the trigger')

  doc.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }))
  assert.equal(view.render().props.children, null)
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  view.dispose()
  assert.equal(ContextObserver.instances[0]?.connected, false)
  const nativeClick = new Event('click', { cancelable: true })
  trigger.dispatchEvent(nativeClick)
  assert.equal(nativeClick.defaultPrevented, false, 'disposing must restore the native click behavior')
})

test('native summary handles absent, zero, and independently arriving projection fields', async t => {
  const { dock, anchor, restore } = setupDom()
  const trigger = nativeContext(dock)
  let pressure: unknown = { pressureTokens: 12_500, contextWindow: 1_000_000 }
  let breakdown: unknown
  let locale = contextLocale('en')
  const rpc = { call: async () => ({ ok: true as const, value: contextValue() }) }
  const view = createHookRenderer(() => {
    const output = MagpieContextMeter({
      rpc, sessionId: 'dsh-session', locale,
      useProjection: key => { useState(key); return key === 'contextPressure' ? pressure : breakdown },
    })!
    ;(output as unknown as { ref: { current: ContextElement } }).ref.current = anchor
    return output
  }, {}, { checkHookOrder: true })
  t.after(() => { view.dispose(); restore() })
  view.render()
  await setImmediate()
  view.render()
  trigger.dispatchEvent(new Event('click', { cancelable: true }))
  const opened = portalOf(view.render()).children as ReactElement
  const readSummary = (): string => {
    const panel = portalOf(view.render()).children as ReactElement
    assert.equal(panel.ref, opened.ref)
    const summary = panel.props.children[0] as ReactElement | null
    return summary === null ? '' : renderToStaticMarkup(summary)
  }
  assert.match(readSummary(), /~12\.5K \/ 1M/u, 'native pressureTokens is the fallback without projectedTokens')
  assert.doesNotMatch(readSummary(), /<dl/u, 'missing breakdown must not invent category counts')

  breakdown = { systemTokens: 0, toolsTokens: 0, messageTokens: 0 }
  const zeroMarkup = readSummary()
  assert.equal((zeroMarkup.match(/<span>~0<\/span>/gu) ?? []).length, 3)
  assert.equal((zeroMarkup.match(/>0%<\/span>/gu) ?? []).length, 3)
  assert.doesNotMatch(zeroMarkup, /NaN|Infinity/u)

  breakdown = { systemTokens: 100, toolsTokens: 200 }
  assert.doesNotMatch(readSummary(), /<dl/u, 'an incomplete estimate must not display a fabricated zero')

  for (const unavailable of [undefined, { pressureTokens: 12_500 }, { pressureTokens: 12_500, contextWindow: 0 }]) {
    pressure = unavailable
    assert.equal(readSummary(), '', 'wait for both native usage and capacity')
  }
  pressure = { projectedTokens: 0, pressureTokens: 12_500, contextWindow: 1_000_000 }
  assert.match(readSummary(), /~0 \/ 1M/u, 'zero projected usage must not fall back to older pressure')
  pressure = { pressureTokens: 2_000_000, contextWindow: 1_000_000 }
  assert.match(readSummary(), /Context used 100%/u, 'bound occupancy as the native meter does')
  locale = contextLocale('zh')
  breakdown = { systemTokens: 1_900, toolsTokens: 8_300, messageTokens: 644 }
  const localized = readSummary()
  for (const key of ['magpie.context.native', 'magpie.context.nativeTools', 'magpie.context.nativeMessages']) {
    assert.ok(localized.includes(zh[key]!))
  }
  assert.equal(trigger.getAttribute('aria-expanded'), 'true')
  assert.equal(ContextObserver.instances.length, 1)
})

test('native context binding survives button replacement and stays inside its own composer', async t => {
  const { body, dock, anchor, restore } = setupDom()
  const first = nativeContext(dock)
  const otherDock = new ContextElement('[data-composer-dock]')
  body.append(otherDock)
  const other = nativeContext(otherDock)
  const rpc = { call: async () => ({ ok: true as const, value: contextValue() }) }
  const view = createHookRenderer(() => {
    const output = MagpieContextMeter({
      rpc, sessionId: 'dsh-session',
      useProjection: key => {
        useState(key)
        return key === 'contextPressure' ? { pressureTokens: 12_500, contextWindow: 1_000_000 }
          : { systemTokens: 1_900, toolsTokens: 8_300, messageTokens: 644 }
      },
    })!
    ;(output as unknown as { ref: { current: ContextElement } }).ref.current = anchor
    return output
  }, {})
  t.after(() => { view.dispose(); restore() })
  view.render()
  await setImmediate()
  view.render()
  first.parentElement!.remove()
  const replacement = nativeContext(dock)
  ContextObserver.instances[0]!.flush()
  for (const untouched of [first, other]) {
    const click = new Event('click', { cancelable: true })
    untouched.dispatchEvent(click)
    assert.equal(click.defaultPrevented, false, 'a detached or different composer button must stay native')
  }
  replacement.dispatchEvent(new Event('click', { cancelable: true }))
  assert.equal((portalOf(view.render()).children as ReactElement).props.role, 'dialog')
  view.dispose()
  assert.equal(replacement.getAttribute('aria-expanded'), 'false', 'unmounting an open Magpie panel restores native accessibility state')
})

test('the native popup stays available until Magpie is ready and is restored when its data clears', async t => {
  const { dock, anchor, restore } = setupDom()
  const trigger = nativeContext(dock)
  let value: MagpieContextSession | null = null
  const rpc = { call: async () => ({ ok: true as const, value }) }
  const store = getMagpieContextStore(rpc, 'dsh-session')
  const view = createHookRenderer(() => {
    const output = MagpieContextMeter({ rpc, sessionId: 'dsh-session' })!
    ;(output as unknown as { ref: { current: ContextElement } }).ref.current = anchor
    return output
  }, {}, { checkHookOrder: true })
  t.after(() => { view.dispose(); restore() })
  view.render()
  await setImmediate()
  view.render()
  const initialClick = new Event('click', { cancelable: true })
  trigger.dispatchEvent(initialClick)
  assert.equal(initialClick.defaultPrevented, false)
  assert.equal(ContextObserver.instances.length, 0, 'a non-Magpie session must keep its native interaction')

  value = contextValue()
  await store.refresh()
  view.render()
  trigger.dispatchEvent(new Event('click', { cancelable: true }))
  portalOf(view.render())
  value = null
  await store.refresh()
  assert.equal(view.render().props.children, undefined)
  assert.equal(ContextObserver.instances[0]?.connected, false)
  assert.equal(trigger.getAttribute('aria-expanded'), 'false')
  const nativeClick = new Event('click', { cancelable: true })
  trigger.dispatchEvent(nativeClick)
  assert.equal(nativeClick.defaultPrevented, false)
})
