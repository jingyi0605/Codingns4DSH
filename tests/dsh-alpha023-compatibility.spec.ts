import assert from 'node:assert/strict'
import test from 'node:test'
import { rankModelByName } from '../src/dsh-capabilities/client/primitives-adapter.js'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import type { BrowserEntryUrl } from '../src/dsh-capabilities/host/browser-entry-url-adapter.js'
import { hostConnectionServices } from '../src/dsh-capabilities/host/connection-peer-adapter.js'

const base = 'http://127.0.0.1:18231'

test('the authentication sub-service is injected only when the host supplies it', () => {
  assert.deepEqual(hostConnectionServices('0.2.2-alpha.2'), ['connection'])
  assert.deepEqual(hostConnectionServices('0.2.2-rc.5'), ['connection'])
  assert.deepEqual(hostConnectionServices('0.2.3-alpha.1'), ['connection', 'connection.authentication'])
})

function resolveEntry(version: string, context: unknown) {
  return createDshCapabilityRegistry(version, 'host', context).getProfile(context)
    .capabilities.get('web.browser-entry-url')
}

test('browser entry URL selects the native interface of each supported DSH line', () => {
  const connection = {
    suffix: '/?token=fixture',
    authenticatedUrl(url: string) { return `${url}${this.suffix}` },
  }
  const old = resolveEntry('0.2.2-rc.5', { connection })
  assert.equal(old?.routeId, 'web-browser-entry-connection-022')
  assert.equal((old?.value as BrowserEntryUrl)(base), `${base}${connection.suffix}`)
  assert.equal(resolveEntry('0.2.1-rc.5', { connection })?.status, 'unavailable')

  const webServer = {}
  const context = {
    webServer,
    emit(subject: unknown, name: string, url: string, entries: unknown[]) {
      assert.equal(subject, webServer)
      assert.equal(name, 'webserver/entry-url')
      assert.equal(url, base)
      entries.push({ label: 'different service', open: true, url: `${url}/other` })
      entries.push({ label: 'dsh web', open: true, url: `${url}/?token=fixture` })
    },
  }
  const route = resolveEntry('0.2.3-alpha.1', context)
  assert.equal(route?.routeId, 'web-browser-entry-event-023')
  assert.equal((route?.value as BrowserEntryUrl)(base), `${base}/?token=fixture`)
  const noToken = resolveEntry('0.2.3-alpha.1', { webServer, emit() {} })
  assert.equal((noToken?.value as BrowserEntryUrl)(base), undefined)
})

test('model search preserves prefix-first ranking without the old Primitives export', () => {
  const items = ['claude-sonnet', 'gpt-mini', 'gpt', 'agent-gpt', 'other'].map(name => ({ name }))
  assert.deepEqual(rankModelByName(items, 'GPT').map(({ name }) => name), ['gpt-mini', 'gpt', 'agent-gpt'])
})
