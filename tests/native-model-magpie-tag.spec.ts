import assert from 'node:assert/strict'
import test from 'node:test'
import { decorateMagpieModels, type NativeModelCatalogEntry } from '../src/client/native-model-translation-menu.js'
import { createMagpieModelTagNode, MagpieModelTag, magpieModelLogoUrl } from '../src/client/magpie-model-tag.js'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PROVIDER_ICON_PATH } from '../src/shared/provider-icon-resources.js'

class FakeText {
  readonly value: string

  constructor(value: string) {
    this.value = value
  }
}

class FakeElement {
  readonly children: FakeElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly style: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  parentElement: FakeElement | null = null
  title = ''
  private text = ''

  readonly tagName: string

  constructor(tagName: string) {
    this.tagName = tagName
  }

  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join('') }
  set textContent(value: string) { this.text = value; this.children.splice(0) }
  get childElementCount(): number { return this.children.length }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
    if (name === 'data-model-id') this.dataset.modelId = value
  }

  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }

  append(...nodes: Array<FakeElement | FakeText>): void {
    for (const node of nodes) {
      if (node instanceof FakeText) this.text += node.value
      else { node.parentElement = this; this.children.push(node) }
    }
  }

  after(node: FakeElement): void {
    if (this.parentElement === null) return
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    node.parentElement = this.parentElement
    siblings.splice(index + 1, 0, node)
  }

  remove(): void {
    if (this.parentElement === null) return
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    if (index >= 0) siblings.splice(index, 1)
    this.parentElement = null
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const selectors = selector.split(',').map((value) => value.trim())
    const found: FakeElement[] = []
    const visit = (parent: FakeElement): void => {
      for (const child of parent.children) {
        if (selectors.some((part) => child.matches(part))) found.push(child)
        visit(child)
      }
    }
    visit(this)
    return found as T[]
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return this.querySelectorAll<T>(selector)[0] ?? null
  }

  matches(selector: string): boolean {
    if (selector === '*') return true
    const match = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/u)
    if (match === null) return false
    const value = this.getAttribute(match[1]!)
    return value !== null && (match[2] === undefined || value === match[2])
  }
}

function modelRow(id: string | undefined, name: string, selected = false): FakeElement {
  const row = new FakeElement('button')
  row.setAttribute('role', 'menuitemradio')
  if (id !== undefined) row.setAttribute('data-model-id', id)
  const label = new FakeElement('span')
  label.textContent = name
  row.append(label)
  if (selected) {
    const check = new FakeElement('span')
    check.textContent = '✓'
    row.append(check)
  }
  return row
}

test('native DSH model options tag exact Magpie IDs and avoid ambiguous labels', () => {
  const menu = new FakeElement('div')
  const magpie = modelRow('auto/gpt-6.1-sol', 'GPT-6.1 Sol', true)
  const ordinarySameName = modelRow('codex/gpt-6.1-sol', 'GPT-6.1 Sol')
  const uniqueLabel = modelRow(undefined, 'MAGPIE-only   alias')
  menu.append(magpie, ordinarySameName, uniqueLabel)

  const models: readonly NativeModelCatalogEntry[] = [
    { id: 'auto/gpt-6.1-sol', name: 'GPT-6.1 Sol', source: 'magpie' },
    { id: 'codex/gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { id: 'alias/provider-model', name: 'Magpie-only alias', source: 'magpie' },
  ]
  const document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: (value: string) => new FakeText(value),
  }

  decorateMagpieModels(menu as never, models, document as never)
  decorateMagpieModels(menu as never, models, document as never)
  const tags = menu.querySelectorAll('[data-codingns-magpie-model-tag]')
  assert.equal(tags.length, 2, 'repeated scans must not duplicate badges')
  assert.equal(tags[0]!.dataset.modelId, 'auto/gpt-6.1-sol')
  assert.equal(tags[1]!.dataset.modelId, 'alias/provider-model')
  assert.equal(magpie.children[magpie.children.length - 1], tags[0], 'the native logo is the trailing row element')
  assert.equal(magpie.children[magpie.children.length - 2]!.textContent, '✓', 'the native checkmark stays before the logo')
  const stableChildren = [...magpie.children]
  decorateMagpieModels(menu as never, models, document as never)
  assert.deepEqual(magpie.children, stableChildren, 'a stable native row is not re-parented on every observer scan')
  for (const tag of tags) {
    assert.equal(tag.children.length, 1, 'the badge contains one logo only')
    assert.equal(tag.style.minWidth, '18px')
    assert.equal(tag.style.height, '18px')
    assert.equal(tag.style.marginInlineStart, 'auto', 'native badges align to the trailing side of the model row')
    assert.equal(tag.children[0]!.tagName, 'img')
    assert.equal(tag.children[0]!.style.width, '16px')
    assert.equal(tag.children[0]!.style.height, '16px')
    assert.equal(tag.children[0]!.getAttribute('src'), magpieModelLogoUrl())
    assert.equal(tag.children[0]!.getAttribute('src'), `${PROVIDER_ICON_PATH}magpie.png`, 'the badge loads the Host-served icon instead of a remote URL')
  }
  assert.equal(ordinarySameName.querySelector('[data-codingns-magpie-model-tag]'), null)

  decorateMagpieModels(menu as never, [{ id: 'codex/gpt-6.1-sol', name: 'GPT-6.1 Sol' }], document as never)
  assert.equal(menu.querySelectorAll('[data-codingns-magpie-model-tag]').length, 0, 'removed Magpie catalog entries lose their stale badge')

  decorateMagpieModels(menu as never, [models[0]!], document as never)
  decorateMagpieModels(menu as never, [], document as never)
  assert.equal(menu.querySelectorAll('[data-codingns-magpie-model-tag]').length, 0, 'an empty catalog also clears stale badges')
})

test('Magpie provider text is shared by React, native DSH and imperative model tags', () => {
  const document = { createElement: (tagName: string) => new FakeElement(tagName) }
  const tag = createMagpieModelTagNode(document as never, 'tlp/shared-model', 'tlp')
  assert.equal(tag.textContent, 'tlp')
  assert.equal(tag.title, 'tlp')
  assert.equal(tag.getAttribute('aria-label'), 'tlp')
  assert.equal(tag.children.length, 2)
  assert.equal(tag.children[0]!.style.fontSize, '12px')
  assert.equal(tag.children[1]!.tagName, 'img', 'provider precedes the Magpie logo')
  const markup = renderToStaticMarkup(createElement(MagpieModelTag, { providerId: 'tlp' }))
  assert.match(markup, />tlp<\/span><img/u)
  assert.match(markup, /font-size:12px/u)
  assert.match(markup, /aria-label="tlp"/u)

  const menu = new FakeElement('div')
  const row = modelRow(undefined, 'Shared Model')
  menu.append(row)
  const models: NativeModelCatalogEntry[] = [{ id: 'tlp/shared-model', name: 'Shared Model', source: 'magpie', magpieProviderId: 'tlp' }]
  decorateMagpieModels(menu as never, models, document as never)
  decorateMagpieModels(menu as never, models, document as never)
  assert.equal(menu.querySelectorAll('[data-codingns-magpie-model-tag]').length, 1)
  assert.equal(row.children[0]!.textContent, 'Shared Model', 'native labels remain owned by DSH')
  assert.equal(row.children[1]!.textContent, 'tlp')

  decorateMagpieModels(menu as never, [{ ...models[0]!, magpieProviderId: 'renamed-provider' }], document as never)
  assert.equal(row.children[1]!.textContent, 'renamed-provider', 'existing tags refresh when provider data changes')
  decorateMagpieModels(menu as never, [{ id: 'tlp/shared-model', name: 'Shared Model', source: 'magpie' }], document as never)
  assert.equal(row.children[1]!.textContent, '', 'older Hosts without provider fields retain logo-only tags')
})
