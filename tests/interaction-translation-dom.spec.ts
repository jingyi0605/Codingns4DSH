import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { NativeTranslatedContent } from '../src/client/session-translation-interactions.js'
import { watchNativeInteractionText } from '../src/dsh-capabilities/client/interaction-text-dom.js'
import type { InteractionTranslationField, InteractionTranslationResult } from '../src/shared/contracts/interaction-translation.js'
import { TRANSLATION_GLYPH_PATHS, TRANSLATION_PENDING_BADGE_STYLE, TRANSLATION_STATUS_BADGE_STYLE } from '../src/shared/translation-indicator.js'

class Observer {
  connected = false
  readonly callback: () => void
  constructor(callback: () => void) { this.callback = callback; observers.push(this) }
  observe() { this.connected = true }
  disconnect() { this.connected = false }
  flush() { if (this.connected) this.callback() }
}
const observers: Observer[] = []
class TextNode {
  readonly nodeType = 3
  parentNode: ElementNode | null = null
  nodeValue: string
  constructor(nodeValue: string) { this.nodeValue = nodeValue }
  get parentElement() { return this.parentNode }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null }
}
class ElementNode {
  readonly nodeType = 1
  readonly childNodes: (ElementNode | TextNode)[] = []
  readonly attributes = new Map<string, string>()
  readonly handlers = new Map<string, (event: any) => void>()
  readonly style = { cssText: '' }
  parentNode: ElementNode | null = null
  title = ''
  textContent = ''
  field = false
  readonly tagName: string
  constructor(tagName: string) { this.tagName = tagName }
  get ownerDocument() { return document }
  setAttribute(key: string, value: string) { this.attributes.set(key, value) }
  getAttribute(key: string) { return this.attributes.get(key) ?? null }
  append(...nodes: (ElementNode | TextNode)[]) { for (const node of nodes) this.insertBefore(node, null) }
  insertBefore(node: ElementNode | TextNode, before: ElementNode | TextNode | null) {
    assert.ok(before === null || this.childNodes.includes(before))
    if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1)
    node.parentNode = this
    this.childNodes.splice(before === null ? this.childNodes.length : this.childNodes.indexOf(before), 0, node)
  }
  remove() { this.parentNode?.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null }
  matches(selector: string): boolean {
    return selector.split(',').some(part => {
      if (part === '[class$="_optionLabel"]') return this.getAttribute('class')?.endsWith('_optionLabel') ?? false
      if (part === '[role="radio"]' || part === '[role="checkbox"]') return this.getAttribute('role') === part.slice(7, -2)
      if (part.startsWith('[')) return this.attributes.has(part.slice(1, -1))
      return this.tagName === part
    })
  }
  closest(selector: string): ElementNode | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null }
  querySelectorAll(_selector: string): ElementNode[] {
    return this.childNodes.flatMap(node => node instanceof ElementNode ? [...(node.field ? [node] : []), ...node.querySelectorAll(_selector)] : [])
  }
  addEventListener(name: string, handler: (event: any) => void) { this.handlers.set(name, handler) }
}
const document = {
  defaultView: { MutationObserver: Observer },
  createElement: (name: string) => new ElementNode(name),
  createElementNS: (_namespace: string, name: string) => new ElementNode(name),
}
function field(text: string, className = '') {
  const element = new ElementNode('span')
  element.field = true
  element.setAttribute('class', className)
  const node = new TextNode(text)
  element.append(node)
  return { element, node }
}
function fixture() {
  const root = new ElementNode('div')
  root.setAttribute('data-question-key', 'native-question')
  const header = field('History Q', 'native_eyebrow')
  const title = field('Which civilization?')
  const option = new ElementNode('button')
  option.setAttribute('role', 'radio')
  option.setAttribute('aria-label', 'Chinese')
  option.setAttribute('aria-checked', 'false')
  const label = field('Chinese', 'native_optionLabel')
  const description = field('Developed oracle bone script')
  option.append(label.element, description.element)
  const input = new ElementNode('textarea')
  const draft = new TextNode('Do not change my draft')
  input.append(draft)
  root.append(header.element, title.element, option, input)
  let fields: readonly InteractionTranslationField[] = []
  const controller = watchNativeInteractionText(root as unknown as HTMLElement, 'question', value => { fields = value })
  const observer = observers.at(-1)!
  const translated = (failedKey?: string) => ({ enabled: true, records: Object.fromEntries(fields.map(item => [item.key, {
    original: item.text, translated: '译文:' + item.text, targetLanguage: 'zh' as const, bilingual: false,
    ...(failedKey === item.key ? { failed: true } : {}),
  }])) })
  return { root, header, title, label, description, option, draft, controller, observer, translated, get fields() { return fields } }
}

const badgeOf = (item: ReturnType<typeof field>) => (item.element.childNodes[1] as ElementNode).childNodes[1] as ElementNode
const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function mountTranslation(f: ReturnType<typeof fixture>) {
  f.controller.dispose()
  let settings = { value: { sessionTranslation: { outputLanguage: 'zh' } } }
  const requests: { fields: readonly InteractionTranslationField[]; signal: AbortSignal; resolve: (value: { ok: true; value: InteractionTranslationResult }) => void; reject: (error: Error) => void }[] = []
  const services: any = {
    settings: { subscribe: () => () => {}, getSnapshot: () => settings },
    rpc: { call: (_channel: string, action: string, payload: any, signal: AbortSignal) => {
      assert.equal(action, 'cli/translation/fields')
      return new Promise((resolve, reject) => { requests.push({ fields: payload.fields, signal, resolve, reject }) })
    } },
  }
  let props = { sessionId: 'test-session', services, kind: 'question' as const, enabled: false, children: createElement('section') }
  const renderer = createHookRenderer(NativeTranslatedContent, props)
  const tree = renderer.render()
  ;(tree as any).ref.current = f.root
  props = { ...props, enabled: true }
  renderer.render(props)
  return {
    renderer, requests,
    language(value: string) { settings = { value: { sessionTranslation: { outputLanguage: value } } }; renderer.render() },
    disable() { renderer.render({ ...props, enabled: false }) },
  }
}

test('independent translations share one question marker and one marker at the end of each answer', () => {
  const f = fixture()
  assert.deepEqual(f.fields.map(item => item.text), ['History Q', 'Which civilization?', 'Chinese', 'Developed oracle bone script'])
  assert.equal(f.title.node.nodeValue, 'Which civilization?')
  assert.equal(f.header.element.childNodes.length, 1)
  assert.equal(f.label.element.childNodes.length, 1)
  for (const item of [f.title, f.description]) {
    assert.equal(item.element.childNodes.length, 2)
    const badge = badgeOf(item)
    assert.equal(badge.getAttribute('data-codingns-translation-pending'), '')
    assert.equal(badge.textContent, '')
    for (const [key, value] of Object.entries(TRANSLATION_PENDING_BADGE_STYLE)) assert.equal((badge.style as any)[key], value)
  }
  f.controller.update(f.translated())
  assert.equal(f.header.element.childNodes.length, 1)
  assert.equal(f.label.element.childNodes.length, 1)
  const questionMarker = f.title.element.childNodes[1] as ElementNode
  const answerMarker = f.description.element.childNodes[1] as ElementNode
  assert.equal(questionMarker.title, 'History Q\nWhich civilization?')
  assert.equal(answerMarker.title, 'Chinese\nDeveloped oracle bone script')
  for (const item of [f.title, f.description]) {
    const marker = item.element.childNodes[1] as ElementNode
    assert.equal(marker.tagName, 'span')
    assert.equal(marker.getAttribute('tabindex'), null)
    assert.equal(marker.getAttribute('role'), null)
    const icon = marker.childNodes[0] as ElementNode
    assert.deepEqual(icon.childNodes.map(path => (path as ElementNode).getAttribute('d')), [...TRANSLATION_GLYPH_PATHS])
    const badge = marker.childNodes[1] as ElementNode
    assert.equal(badge.textContent, '✓')
    assert.equal(badge.getAttribute('data-codingns-translation-pending'), null)
    assert.equal((badge.style as any).width, TRANSLATION_STATUS_BADGE_STYLE.width)
  }
  assert.equal(f.option.getAttribute('aria-label'), '译文:Chinese')
  assert.equal(f.option.getAttribute('aria-checked'), 'false')
  assert.equal(f.draft.nodeValue, 'Do not change my draft')
  f.controller.dispose()
})

for (const state of ['pending', 'complete', 'failed']) test(state + ' translation marker consumes pointer and click events without selecting the native option', () => {
  const f = fixture()
  if (state !== 'pending') f.controller.update(state === 'complete' ? f.translated() : { enabled: true, records: {} })
  const marker = f.description.element.childNodes[1] as ElementNode
  for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
    let prevented = false, stopped = false
    marker.handlers.get(type)!({ preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
    assert.ok(prevented && stopped)
  }
  assert.equal(f.option.getAttribute('aria-checked'), 'false')
  f.controller.dispose()
})

test('a native rerender or pagination change retires stale translations without replacing React text nodes', () => {
  const f = fixture()
  f.controller.update(f.translated())
  const old = f.fields.find(field => field.text === 'Which civilization?')!.key
  f.title.node.nodeValue = 'Next question?'
  f.observer.flush()
  assert.equal(f.title.element.childNodes[0], f.title.node)
  assert.equal(f.title.node.nodeValue, 'Next question?')
  assert.notEqual(f.fields.find(field => field.text === 'Next question?')!.key, old)
  assert.equal(badgeOf(f.title).getAttribute('data-codingns-translation-pending'), '')
  f.controller.update(f.translated())
  assert.equal(f.title.node.nodeValue, '译文:Next question?')
  assert.equal((f.title.element.childNodes[1] as ElementNode).title, 'History Q\nNext question?')
  f.controller.dispose()
})

test('failure retains the original field and disposal restores native text and accessibility labels', () => {
  const f = fixture()
  f.controller.update(f.translated(f.fields[3]!.key))
  assert.equal(f.description.node.nodeValue, 'Developed oracle bone script')
  const marker = f.description.element.childNodes[1] as ElementNode
  assert.equal(marker.title, 'Chinese\nDeveloped oracle bone script')
  assert.equal((marker.childNodes[1] as ElementNode).textContent, '!')
  assert.equal(badgeOf(f.description).getAttribute('data-codingns-translation-pending'), null)
  f.controller.dispose()
  assert.equal(f.title.node.nodeValue, 'Which civilization?')
  assert.equal(f.label.node.nodeValue, 'Chinese')
  assert.equal(f.option.getAttribute('aria-label'), 'Chinese')
  assert.equal(f.label.element.childNodes.length, 1)
  assert.equal(f.description.element.childNodes.length, 1)
  assert.equal(f.observer.connected, false)
})

test('an answer without a description has one marker after its label and retains it across rescans', () => {
  const f = fixture()
  f.description.element.remove()
  f.observer.flush()
  f.controller.update(f.translated())
  const marker = f.label.element.childNodes[1] as ElementNode
  assert.equal(marker.title, 'Chinese')
  for (let i = 0; i < 3; i++) f.observer.flush()
  assert.equal(f.label.element.childNodes.length, 2)
  assert.equal(f.label.element.childNodes[1], marker)
  f.controller.update({ enabled: false, records: {} })
  assert.equal(f.label.element.childNodes.length, 1)
  assert.equal(f.title.element.childNodes.length, 1)
  f.controller.dispose()
})

test('answers with the same label retain separate markers and complete original tooltips', () => {
  const f = fixture()
  const second = new ElementNode('button')
  second.setAttribute('role', 'radio')
  second.setAttribute('aria-label', 'Chinese')
  const label = field('Chinese', 'native_optionLabel')
  const description = field('Another description')
  second.append(label.element, description.element)
  f.root.append(second)
  f.observer.flush()
  f.controller.update(f.translated())
  assert.equal(f.header.element.childNodes.length, 1)
  assert.equal(f.title.element.childNodes.length, 2)
  assert.equal(f.label.element.childNodes.length, 1)
  assert.equal(label.element.childNodes.length, 1)
  const firstMarker = f.description.element.childNodes[1] as ElementNode
  const secondMarker = description.element.childNodes[1] as ElementNode
  assert.notEqual(firstMarker, secondMarker)
  assert.equal(firstMarker.title, 'Chinese\nDeveloped oracle bone script')
  assert.equal(secondMarker.title, 'Chinese\nAnother description')
  f.controller.dispose()
})

test('markdown keeps its structure and code while model text is inserted only as text', () => {
  const f = fixture()
  const detail = new ElementNode('div')
  detail.field = true
  const emphasis = new ElementNode('strong')
  const prose = new TextNode('Keep the file')
  emphasis.append(prose)
  const code = new ElementNode('code')
  const path = new TextNode('src/main.ts')
  code.append(path)
  detail.append(emphasis, code)
  f.root.append(detail)
  f.observer.flush()
  assert.equal(f.fields.some(item => item.text === path.nodeValue), false)
  const key = f.fields.find(item => item.text === prose.nodeValue)!.key
  const result = f.translated()
  result.records[key]!.translated = '<img src=x onerror=alert(1)>'
  f.controller.update(result)
  assert.equal(prose.nodeValue, '<img src=x onerror=alert(1)>')
  assert.equal(detail.childNodes[0], emphasis)
  assert.equal(path.nodeValue, 'src/main.ts')
  f.controller.dispose()
})

test('separate native panels cannot apply each other\'s translations', () => {
  const first = fixture(), second = fixture()
  first.controller.update(first.translated())
  assert.equal(second.title.node.nodeValue, 'Which civilization?')
  first.controller.dispose()
  second.controller.dispose()
})

test('unchanged translations finish successfully and entirely failed groups retain a stopped error indicator', () => {
  const f = fixture()
  const unchanged = f.translated()
  for (const record of Object.values(unchanged.records)) record.translated = record.original
  f.controller.update(unchanged)
  for (const item of [f.title, f.description]) {
    assert.equal(badgeOf(item).textContent, '✓')
    assert.equal(badgeOf(item).getAttribute('data-codingns-translation-pending'), null)
  }
  const failed = f.translated()
  for (const record of Object.values(failed.records)) record.failed = true
  f.controller.update(failed)
  for (const item of [f.title, f.description]) {
    assert.equal(badgeOf(item).textContent, '!')
    assert.equal(badgeOf(item).getAttribute('data-codingns-translation-pending'), null)
  }
  assert.equal(f.description.node.nodeValue, 'Developed oracle bone script')
  f.controller.dispose()
})

test('native boundary shows pending icons before RPC completion, restarts on settings changes, and stops on RPC failure', async () => {
  const f = fixture()
  const m = mountTranslation(f)
  assert.equal(m.requests.length, 1)
  assert.equal(f.title.node.nodeValue, 'Which civilization?')
  assert.equal(badgeOf(f.title).getAttribute('data-codingns-translation-pending'), '')
  assert.equal(badgeOf(f.description).getAttribute('data-codingns-translation-pending'), '')
  m.requests[0]!.resolve({ ok: true, value: f.translated() })
  await tick()
  m.renderer.render()
  assert.equal(f.title.node.nodeValue, '译文:Which civilization?')
  assert.equal(badgeOf(f.title).textContent, '✓')
  m.language('ja')
  assert.equal(m.requests.length, 2)
  assert.equal(f.title.node.nodeValue, 'Which civilization?')
  assert.equal(badgeOf(f.title).getAttribute('data-codingns-translation-pending'), '')
  m.requests[1]!.reject(new Error('offline'))
  await tick()
  m.renderer.render()
  for (const item of [f.title, f.description]) {
    assert.equal(badgeOf(item).textContent, '!')
    assert.equal(badgeOf(item).getAttribute('data-codingns-translation-pending'), null)
  }
  m.language('en')
  m.requests[2]!.resolve({ ok: true, value: { enabled: false, records: {} } })
  await tick()
  m.renderer.render()
  assert.equal(f.title.element.childNodes.length, 1)
  assert.equal(f.description.element.childNodes.length, 1)
  m.renderer.dispose()
})

test('native pagination ignores a late translation and disabling translation removes pending icons', async () => {
  const f = fixture()
  const m = mountTranslation(f)
  f.title.node.nodeValue = 'Next question?'
  observers.at(-1)!.flush()
  m.renderer.render()
  assert.equal(m.requests.length, 2)
  assert.equal(m.requests[0]!.signal.aborted, true)
  m.requests[0]!.resolve({ ok: true, value: f.translated() })
  await tick()
  m.renderer.render()
  assert.equal(f.title.node.nodeValue, 'Next question?')
  assert.equal(badgeOf(f.title).getAttribute('data-codingns-translation-pending'), '')
  m.disable()
  assert.equal(m.requests[1]!.signal.aborted, true)
  assert.equal(f.title.element.childNodes.length, 1)
  assert.equal(f.description.element.childNodes.length, 1)
  m.renderer.dispose()
})
