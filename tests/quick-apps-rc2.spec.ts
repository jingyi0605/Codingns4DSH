import assert from 'node:assert/strict'
import test from 'node:test'
import type { ComponentType } from 'react'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import type { QuickAppProxyServer } from '../src/dsh-capabilities/host/quick-app-proxy-adapter.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { quickAppsFeature } from '../src/client/features/quick-apps.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'
import { QuickAppsLauncher } from '../src/client/quick-apps/launcher.js'
import { DEFAULT_CODINGNS_SETTINGS, enabledFeatureNames } from '../src/shared/contracts/config.js'

for (const version of ['0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3']) {
  test(`Quick Apps setting mounts and disposes the native footer on DSH ${version}`, async () => {
    const events: string[] = []
    let render!: (props: { wide: boolean }) => { type: unknown; props: { wide: boolean } }
    const slots = {
      inject(name: string, install: () => () => void) {
        assert.equal(name, 'sidebar.footer.action')
        const release = install()
        return () => { release(); events.push('inject-disposed') }
      },
      register(options: { name: string; id: string }, component: ComponentType<{ wide: boolean }>) {
        assert.equal(options.name, 'sidebar.footer.action')
        assert.equal(options.id, 'codingns-quick-apps')
        render = component as typeof render
        events.push('mounted')
        return () => { events.push('entry-disposed') }
      },
    }
    const services = { slots } as unknown as CodingNsClientServices
    const profile = createDshCapabilityRegistry(version, 'client', services).getProfile(services)
    const registry = new FeatureRegistry(services, profile)
    registry.register(quickAppsFeature)
    await registry.reconcile(enabledFeatureNames(registry.descriptors(), { ...DEFAULT_CODINGNS_SETTINGS, modules: { quickApps: true } }))
    assert.equal(registry.getState('quickApps'), 'enabled')
    assert.deepEqual(events, ['mounted'])
    for (const wide of [true, false]) {
      assert.equal(render({ wide }).type, QuickAppsLauncher)
      assert.equal(render({ wide }).props.wide, wide)
    }
    await registry.disable('quickApps')
    assert.deepEqual(events, ['mounted', 'entry-disposed', 'inject-disposed'])
  })
}

test('Quick Apps remains disabled with an explainable missing-footer diagnostic', async () => {
  const services = {} as CodingNsClientServices
  const profile = createDshCapabilityRegistry('0.2.0-rc.2', 'client', services).getProfile(services)
  const registry = new FeatureRegistry(services, profile)
  registry.register(quickAppsFeature)
  await registry.start('quickApps')
  const snapshot = registry.getSnapshot('quickApps')
  assert.equal(snapshot.state, 'disabled')
  assert.ok(snapshot.reason)
  assert.ok(snapshot.capabilities.some(item => item.capability === 'sidebar.footer-action'))
})

test('rc.2 proxy adapter uses the actual listener port and keeps native route ownership', () => {
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    let released = false
    const native = { host, port: 12345, register(route: { path: string }) {
      assert.equal(this, native)
      assert.equal(route.path, '/preview')
      return () => { released = true }
    } }
    const context = { webServer: native }
    const capability = createDshCapabilityRegistry('0.2.0-rc.2', 'host', context).getProfile(context).capabilities.get('quick-app.proxy')!
    assert.equal(capability.status, 'ready')
    const proxy = capability.value as QuickAppProxyServer
    assert.equal(proxy.getOrigin(), 'http://127.0.0.1:12345')
    native.port = 23456
    assert.equal(proxy.getOrigin(), 'http://127.0.0.1:23456')
    const release = proxy.register({ kind: 'prefix', path: '/preview', handler: async () => {} })
    assert.equal(typeof release, 'function')
    assert.equal(released, false)
    void release()
    assert.equal(released, true)
    native.port = 0
    assert.throws(() => proxy.getOrigin())
  }
})

test('proxy detection rejects incomplete or untrusted rc.2 listener shapes', () => {
  const register = () => () => {}
  for (const webServer of [{ register }, { register, host: 'example.test', port: 12345 },
    ...[0, -1, 65536, 1.5, '12345'].map(port => ({ register, host: '127.0.0.1', port }))]) {
    const context = { webServer }
    const profile = createDshCapabilityRegistry('0.2.0-rc.2', 'host', context).getProfile(context)
    assert.equal(profile.capabilities.get('quick-app.proxy')?.status, 'unavailable')
    assert.ok(profile.diagnostics.some(item => item.capability === 'quick-app.proxy'))
  }
})

test('modern proxy adapters preserve the native origin method and its receiver', () => {
  const native = { getOrigin() { assert.equal(this, native); return 'https://host.example.test' }, register: () => () => {} }
  const context = { webServer: native }
  const capability = createDshCapabilityRegistry('0.2.1-alpha.3', 'host', context).getProfile(context).capabilities.get('quick-app.proxy')!
  assert.equal(capability.status, 'ready')
  assert.equal((capability.value as QuickAppProxyServer).getOrigin(), 'https://host.example.test')
})
