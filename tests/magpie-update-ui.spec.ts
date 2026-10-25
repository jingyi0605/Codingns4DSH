import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MagpieManagementPage } from '../src/client/features/magpie-management-page.js'
import { resolveCodingNsTranslator, type CodingNsLocale } from '../src/client/locale.js'
import type { CodingNsRpcClient } from '../src/client/features/types.js'
import type { MagpieUpdateStatus } from '../src/shared/contracts/magpie-management.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const t = resolveCodingNsTranslator()
const locale = {
  bind: () => t,
  getSnapshot: () => ({ revision: 0 }),
  subscribe: () => () => undefined,
  register: () => () => undefined,
} as unknown as CodingNsLocale

function status(state: MagpieUpdateStatus['state'], latest: string | null = '0.1.1392'): MagpieUpdateStatus {
  return {
    state, current: '0.1.1391', latest, notes: null, url: null, stuck: null, error: null,
    retry: false, done: null, total: null, size: null, waiting: false, gaveUp: false,
  }
}

function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  return isValidElement(node) ? [node, ...elements((node.props as any).children)] : []
}

function versionButton(tree: ReactElement): ReactElement<any> {
  const button = elements(tree).find(element => element.type === 'button' && element.props.className.startsWith('codingns-magpie-version-button'))
  assert.ok(button)
  return button
}

function updateDialog(tree: ReactElement): ReactElement<any> {
  const dialog = elements(tree).find(element => typeof element.props.onConfirm === 'function')
  assert.ok(dialog)
  return dialog
}

function page(context: TestContext, request: (endpoint: string) => unknown | Promise<unknown>) {
  const calls: { endpoint: string; payload: unknown; signal: AbortSignal | undefined }[] = []
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let windowInstalled = false
  const rpc: CodingNsRpcClient = {
    async call(_channel, endpoint, payload, signal) {
      calls.push({ endpoint, payload, signal })
      if (endpoint === 'magpie/update/notes') {
        return { ok: true, value: await request(endpoint) ?? { latest: '0.1.1392', releases: [], error: null } }
      }
      return { ok: true, value: await request(endpoint) ?? null }
    },
  }
  const renderer = createHookRenderer(MagpieManagementPage, { rpc, locale }, { checkHookOrder: true })
  context.after(() => {
    renderer.dispose()
    if (!windowInstalled) return
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else delete (globalThis as any).window
  })
  const render = () => renderer.render()
  const open = (): ReactElement => {
    if (!windowInstalled) {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() })
      windowInstalled = true
    }
    versionButton(render()).props.onClick()
    return render()
  }
  return { calls, renderer, render, open }
}

test('opening Magpie checks for updates and adds an accessible version badge without installing', async context => {
  const view = page(context, endpoint => {
    if (endpoint === 'magpie/update/status') return status('latest', '0.1.1391')
    if (endpoint === 'magpie/update/check') return status('found')
  })
  view.render()
  await setImmediate()
  const button = versionButton(view.render())
  assert.equal(button.props.className, 'codingns-magpie-version-button has-update')
  assert.equal(button.props['aria-label'], t('magpie.update.openAvailable', { version: '0.1.1391', latest: '0.1.1392' }))
  assert.equal(button.props.title, button.props['aria-label'])
  const markup = renderToStaticMarkup(button)
  assert.match(markup, />0\.1\.1391<span class="codingns-magpie-update-badge"/u)
  assert.ok(markup.includes(t('magpie.update.badge')))
  assert.deepEqual(view.calls.filter(call => call.endpoint.startsWith('magpie/update/')).map(call => call.endpoint), [
    'magpie/update/status', 'magpie/update/check', 'magpie/update/notes',
  ])
})

test('opening Magpie again runs a fresh check and the badge clears when the installed version is current', async context => {
  let latest = '0.1.1392'
  const request = (endpoint: string) => {
    if (endpoint === 'magpie/update/status') return status('latest', '0.1.1391')
    if (endpoint === 'magpie/update/check') return status(latest === '0.1.1391' ? 'latest' : 'found', latest)
  }
  const first = page(context, request)
  first.render()
  await setImmediate()
  assert.match(versionButton(first.render()).props.className, /has-update/u)
  first.renderer.dispose()
  latest = '0.1.1391'
  const second = page(context, request)
  second.render()
  await setImmediate()
  const button = versionButton(second.render())
  assert.equal(button.props.className, 'codingns-magpie-version-button')
  assert.equal(button.props['aria-label'], t('magpie.update.open', { version: '0.1.1391' }))
  assert.doesNotMatch(renderToStaticMarkup(button), /codingns-magpie-update-badge/u)
  assert.equal(second.calls.filter(call => call.endpoint === 'magpie/update/check').length, 1)
})

test('a confirmed update advances from downloading to installation controls without refreshing', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let current = status('found')
  const view = page(context, endpoint => {
    if (endpoint === 'magpie/update/status' || endpoint === 'magpie/update/check') return current
    if (endpoint === 'magpie/update/install') {
      current = { ...status('downloading'), done: 25, total: 100 }
      return { requested: true, restartExpected: false, status: current }
    }
  })
  view.render()
  await setImmediate()
  const dialog = updateDialog(view.open())
  dialog.props.onConfirmingChange(true)
  view.render()
  await dialog.props.onConfirm()
  let tree = view.render()
  assert.equal(updateDialog(tree).props.status.state, 'downloading')
  assert.match(renderToStaticMarkup(tree), /width:25%/u)
  assert.equal(view.calls.filter(call => call.endpoint === 'magpie/update/install').length, 1)
  assert.deepEqual(view.calls.find(call => call.endpoint === 'magpie/update/install')?.payload, { confirmed: true })

  current = status('ready')
  context.mock.timers.tick(1000)
  await setImmediate()
  tree = view.render()
  assert.equal(updateDialog(tree).props.status.state, 'ready')
  const markup = renderToStaticMarkup(tree)
  assert.ok(markup.includes(t('magpie.update.state.ready')))
  assert.ok(markup.includes(t('magpie.update.manual')))
  assert.ok(!markup.includes(t('magpie.update.downloading')))
  const reads = view.calls.length
  context.mock.timers.tick(5000)
  await setImmediate()
  assert.equal(view.calls.length, reads, 'polling stops at ready without another install request')
})

for (const initial of ['checking', 'downloading', 'ready'] as const) {
  test(`opening Magpie preserves ${initial} and observes active work without restarting the check`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    let current = status(initial)
    const view = page(context, endpoint => endpoint === 'magpie/update/status' ? current : undefined)
    view.render()
    await setImmediate()
    view.render()
    assert.equal(view.calls.some(call => call.endpoint === 'magpie/update/check'), false)
    const reads = view.calls.filter(call => call.endpoint === 'magpie/update/status').length
    current = status('ready')
    context.mock.timers.tick(1000)
    await setImmediate()
    const dialog = updateDialog(view.open())
    assert.equal(dialog.props.status.state, 'ready')
    assert.equal(view.calls.filter(call => call.endpoint === 'magpie/update/status').length, reads + (initial === 'ready' ? 0 : 1))
  })
}

test('failed release notes do not hide an available update or its installation controls', async context => {
  const view = page(context, endpoint => {
    if (endpoint === 'magpie/update/notes') throw new Error('Release notes unavailable')
    if (endpoint === 'magpie/update/status' || endpoint === 'magpie/update/check') return status('found')
  })
  view.render()
  await setImmediate()
  const dialog = updateDialog(view.open())
  assert.equal(dialog.props.error, null)
  assert.equal(dialog.props.loading, false)
  assert.equal(dialog.props.status.state, 'found')
  assert.ok(renderToStaticMarkup(dialog).includes(t('magpie.update.manual')))
})

test('a slow release-notes response does not delay download polling', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let current = status('downloading')
  const view = page(context, endpoint => {
    if (endpoint === 'magpie/update/status') return current
    if (endpoint === 'magpie/update/notes') return new Promise(() => undefined)
  })
  view.render()
  await setImmediate()
  view.render()
  current = status('ready')
  context.mock.timers.tick(1000)
  await setImmediate()
  const dialog = updateDialog(view.open())
  assert.equal(dialog.props.status.state, 'ready')
  assert.equal(dialog.props.loading, false)
})

test('polling recovers after a temporary status failure and keeps running with the dialog closed', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  const view = page(context, endpoint => {
    if (endpoint !== 'magpie/update/status') return
    reads += 1
    if (reads === 2) throw new Error('Temporary connection failure')
    return status(reads > 2 ? 'ready' : 'downloading')
  })
  view.render()
  await setImmediate()
  view.render()
  context.mock.timers.tick(1000)
  await setImmediate()
  view.render()
  context.mock.timers.tick(1000)
  await setImmediate()
  const dialog = updateDialog(view.open())
  assert.equal(dialog.props.status.state, 'ready')
  assert.equal(dialog.props.error, null)
  assert.equal(reads, 3)
})

test('status polls do not overlap and unmount aborts an outstanding read and discards its response', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let finish: ((value: MagpieUpdateStatus) => void) | undefined
  let reads = 0
  const view = page(context, endpoint => {
    if (endpoint !== 'magpie/update/status') return
    reads += 1
    if (reads === 1) return status('downloading')
    return new Promise<MagpieUpdateStatus>(resolve => { finish = resolve })
  })
  view.render()
  await setImmediate()
  view.render()
  context.mock.timers.tick(1000)
  assert.equal(reads, 2)
  context.mock.timers.tick(10_000)
  assert.equal(reads, 2, 'the next poll waits for the previous response')
  const pending = view.calls.filter(call => call.endpoint === 'magpie/update/status').at(-1)!
  assert.equal(pending.signal?.aborted, false)
  view.renderer.dispose()
  assert.equal(pending.signal?.aborted, true)
  finish!(status('ready'))
  await setImmediate()
  context.mock.timers.tick(10_000)
  assert.equal(reads, 2, 'an aborted poll cannot schedule another read')
})
