import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { registerCliConversationSlots } from '../src/client/cli-slots.js'
import { watchNativeModelMenu } from '../src/client/native-model-translation-menu.js'
import { composerSlotSelector, contextComposerSlotName } from '../src/dsh-capabilities/client/composer-slot-selectors.js'
import { createSessionPerformancePresentation } from '../src/dsh-capabilities/client/session-performance-adapter.js'
import { createPresentationSlots } from './fixtures/presentation-slots.ts'
import { quickAppBrowser } from './quick-apps-browser-driver.js'

function composerStyles(): string {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let css = ''
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (style: { textContent: string }) => { css = style.textContent } },
  } })
  try {
    const dispose = registerCliConversationSlots({ inject: () => () => undefined } as never, {} as never, { bind: () => (key: string) => key } as never)
    dispose()
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'document')
    else Object.defineProperty(globalThis, 'document', original)
  }
  assert.ok(css.length > 0)
  return css
}

function mirroredSlots() {
  const slots = createPresentationSlots()
  const root = slots.register({ name: 'root', children: {
    'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
  } }, (() => null) as never)
  const native = slots.register({ name: 'conversation.composer.bar', children: {
    'conversation.composer.dock': { kind: 'list', scope: 'session' },
    'conversation.input.right': { kind: 'list', scope: 'session' },
    'conversation.input.model': { kind: 'single', scope: 'session' },
  } }, (() => null) as never)
  const dispose = createSessionPerformancePresentation({ slots }).install(() => 'codex', createElement)
  try {
    const entry = slots.core.entriesOfSlot('conversation.composer.bar')[0]!
    const wrapped = (entry.component as any)({ sessionId: 'fixture', renderSlot: (name: string) => name })
    return {
      right: wrapped.props.renderSlot('conversation.input.right', {}),
      model: wrapped.props.renderSlot('conversation.input.model', {}),
    } as { right: string; model: string }
  } finally { dispose(); native(); root() }
}

const nativeSlots = { right: 'conversation.input.right', model: 'conversation.input.model' }

// Reproduce the native toolbar hierarchy; the production plugin supplies all tested overrides.
function composer(id: string, slots: typeof nativeSlots, adapter: string, control = 'button'): string {
  return `<div data-composer-card id="${id}"><div class="fixture_row"><div class="fixture_tools">Tools</div>
    <div class="fixture_trailing"><div class="fixture_standardControls">
      <div data-slot="${slots.right}" style="display:contents">
        <div data-codingns-agent="${adapter}" style="flex:none;width:24px">A</div>
        <div class="codingns4dsh-model-root" style="min-width:0;display:${adapter === 'dsh' ? 'none' : 'inline-flex'};flex:1 1 min(360px,45cqw)">
          <button data-picker="external" style="width:100%;min-width:0;display:inline-flex;align-items:center">
            <span class="codingns4dsh-model-icon" style="width:16px">M</span>
            <span class="codingns4dsh-model-name" style="min-width:0;max-width:150px;overflow:hidden;white-space:nowrap">A very long external model name</span>
            <span class="codingns4dsh-model-effort">high</span><span>⌄</span>
          </button>
        </div><span data-menu-anchor hidden></span>
      </div>
      <div data-slot="${slots.model}" style="display:contents"><${control} data-picker="native" aria-haspopup="menu" aria-expanded="true" aria-controls="${id}-menu" style="width:900px">${control === 'select' ? '<option>A very long native model name</option>' : 'Native model'}</${control}></div>
    </div><button data-send style="flex:none;width:34px;height:34px" onclick="this.dataset.clicked='true'">↑</button></div>
  </div></div><div id="${id}-menu" role="menu"><button role="menuitem">Model</button></div>`
}

test('original and mirrored composers keep one model picker, responsive sizing, and an unobstructed send button', { timeout: 30_000 }, async t => {
  const browser = await quickAppBrowser(t)
  if (browser === undefined) return
  const css = composerStyles()
  for (const { slots, control } of [nativeSlots, mirroredSlots()].flatMap(slots => ['button', 'select'].map(control => ({ slots, control })))) {
    await browser.command('Page.enable')
    const { frameTree } = await browser.command('Page.getFrameTree')
    await browser.command('Page.setDocumentContent', { frameId: frameTree.frame.id, html: `<style>
      *{box-sizing:border-box}body{margin:0}[data-composer-card]{margin:16px;padding:8px}
      .fixture_row{display:flex;flex-wrap:wrap;gap:12px;min-width:0;container-type:inline-size}
      .fixture_tools{display:flex;flex:none;width:100px}.fixture_trailing{display:flex;align-items:center;min-width:0;flex:none;gap:12px;margin-left:auto}
      .fixture_standardControls{display:flex;align-items:center;min-width:0;gap:12px}
      ${css}</style>${composer('main', slots, 'codex', control)}${composer('side', slots, 'dsh', control)}` })
    for (const width of [390, 768, 1200]) {
      await browser.command('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: false })
      for (const adapter of ['codex', 'grok', 'claude-code', 'dsh', 'codex']) {
        const result = await browser.evaluate(`(() => {
          const main = document.querySelector('#main');
          const adapter = ${JSON.stringify(adapter)};
          main.querySelector('[data-codingns-agent]').dataset.codingnsAgent = adapter;
          main.querySelector('.codingns4dsh-model-root').style.display = adapter === 'dsh' ? 'none' : 'inline-flex';
          for (const row of document.querySelectorAll('.fixture_row')) row.toggleAttribute('data-model-compact', innerWidth < 769);
          const visible = element => element.getClientRects().length > 0;
          const pickers = card => [...card.querySelectorAll('[data-picker]')].filter(visible).map(element => element.dataset.picker);
          const send = main.querySelector('[data-send]'); send.dataset.clicked = ''; const rect = send.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          hit?.click();
          const picker = main.querySelector('[data-picker="' + (adapter === 'dsh' ? 'native' : 'external') + '"]');
          return { main: pickers(main), side: pickers(document.querySelector('#side')), sendHit: hit === send,
            sent: send.dataset.clicked === 'true', noOverlap: picker.getBoundingClientRect().right <= rect.left,
            pickerWidth: picker.getBoundingClientRect().width,
            nativeWidth: document.querySelector('#side [data-picker="native"]').getBoundingClientRect().width,
            rowWidth: main.querySelector('.fixture_row').getBoundingClientRect().width,
            iconVisible: visible(main.querySelector('.codingns4dsh-model-icon')),
            nameVisible: visible(main.querySelector('.codingns4dsh-model-name')),
            fits: document.documentElement.scrollWidth <= innerWidth };
        })()`)
        assert.deepEqual(result.main, [adapter === 'dsh' ? 'native' : 'external'], `${slots.model}, ${control}, ${width}px, ${adapter}`)
        assert.deepEqual(result.side, ['native'], 'An external main session must not hide the side session picker')
        assert.equal(result.sendHit, true)
        assert.equal(result.sent, true)
        assert.equal(result.noOverlap, true)
        assert.equal(result.fits, true)
        assert.ok(result.pickerWidth > 0)
        assert.ok(result.nativeWidth <= Math.min(control === 'select' ? 150 : 360, result.rowWidth * 0.45) + 1, 'Native model width must remain constrained')
        if (adapter !== 'dsh') {
          assert.equal(result.iconVisible, width < 769)
          assert.equal(result.nameVisible, width >= 769)
        }
      }
    }
  }
})

test('native model translation finds original and mirrored menus, stays scoped, and cleans up', { timeout: 30_000 }, async t => {
  const browser = await quickAppBrowser(t)
  if (browser === undefined) return
  await browser.command('Page.enable')
  const { frameTree } = await browser.command('Page.getFrameTree')
  await browser.command('Page.setDocumentContent', { frameId: frameTree.frame.id,
    html: composer('main', mirroredSlots(), 'dsh') + composer('side', nativeSlots, 'dsh') })
  await browser.evaluate(`(() => {
    const contextComposerSlotName = ${contextComposerSlotName.toString()};
    const composerSlotSelector = ${composerSlotSelector.toString()};
    const watchNativeModelMenu = ${watchNativeModelMenu.toString()};
    window.menuRemovers = ['main', 'side'].map(id => {
      const card = document.getElementById(id);
      card.querySelector('[data-picker="native"]').addEventListener('click', event => event.currentTarget.setAttribute('aria-expanded', 'false'));
      return watchNativeModelMenu(card.querySelector('[data-menu-anchor]'), () => {});
    });
  })()`)
  const counts = () => browser.evaluate(`['main-menu', 'side-menu'].map(id => document.getElementById(id).querySelectorAll('[data-codingns-native-translation]').length)`)
  assert.deepEqual(await counts(), [1, 1])
  await browser.evaluate(`document.querySelector('#main [data-picker="native"]').setAttribute('aria-expanded', 'false')`)
  assert.deepEqual(await counts(), [0, 1])
  await browser.evaluate(`document.querySelector('#main [data-picker="native"]').setAttribute('aria-expanded', 'true'); document.getElementById('main-menu').setAttribute('role', 'group')`)
  assert.deepEqual(await counts(), [0, 1])
  await browser.evaluate(`document.getElementById('main-menu').setAttribute('role', 'menu')`)
  assert.deepEqual(await counts(), [1, 1])
  await browser.evaluate(`document.querySelector('#main-menu [data-codingns-native-translation]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
  assert.deepEqual(await counts(), [0, 1])
  await browser.evaluate(`window.menuRemovers.forEach(dispose => dispose()); document.querySelector('#main [data-picker="native"]').setAttribute('aria-expanded', 'true')`)
  assert.deepEqual(await counts(), [0, 0])
})
