import assert from 'node:assert/strict'
import test from 'node:test'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { CodingNsSettingsSection } from '../data/build/dist/client/settings-section.js'
import { createCodingNsSettingsBridge } from '../data/build/dist/client/settings-bridge.js'
import { quickAppsFeature } from '../data/build/dist/client/features/quick-apps.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'
import { createCodingNsRpcHandler, createCodingNsSettingsRpcHandler } from '../data/build/dist/host/rpc.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { CodingNsSettingsSchema } from '../data/build/dist/host/settings.js'
import type { CodingNsSettingsOperation } from '../data/build/dist/dsh-capabilities/settings-store.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

function elements(node: ReactNode): ReactElement<any>[] {
  return isValidElement<{ children?: ReactNode }>(node)
    ? [node, ...Children.toArray(node.props.children).flatMap(elements)] : []
}

test('Quick Apps settings card saves both toggle states through Host RPC and survives reload', async t => {
  let saved = JSON.stringify(CodingNsSettingsSchema({
    modules: { sessionTranslation: true },
    sessionTranslation: { adapterOptions: { codex: { inputEnabled: false } } },
  } as never))
  const originalTranslation = JSON.parse(saved).sessionTranslation
  let revision = 1
  let writes = 0
  const table = new CodingNsRpcTable()
  table.register('settings', createCodingNsSettingsRpcHandler({
    writable: true,
    describe: () => [{ ns: '@jingyi0605/codingns4dsh', revision }],
    get: () => CodingNsSettingsSchema(JSON.parse(saved)),
    async mutate(namespace: string, operations: readonly CodingNsSettingsOperation[]) {
      assert.equal(namespace, '@jingyi0605/codingns4dsh')
      const current = JSON.parse(saved)
      for (const operation of operations) {
        assert.deepEqual(operation.path, ['modules', 'quickApps'])
        assert.equal(operation.op, 'set')
        current.modules.quickApps = operation.value
      }
      saved = JSON.stringify(CodingNsSettingsSchema(current))
      revision++
      writes++
    },
  } as never))
  const handler = createCodingNsRpcHandler(table)
  const rpc = { call: async (_channel: string, endpoint: string, payload: unknown) =>
    handler(endpoint, payload, new AbortController().signal, { id: 'settings-owner' }) }
  const settings = createCodingNsSettingsBridge(undefined, rpc)
  t.after(() => settings.dispose())
  await settings.load()
  const localeSnapshot = { revision: 0 }
  const services = {
    settings, dshVersion: '0.2.1-alpha.3',
    locale: { bind: () => (key: string) => key, subscribe: () => () => {}, getSnapshot: () => localeSnapshot },
  }
  const registry = new FeatureRegistry(services as never)
  registry.register(quickAppsFeature)
  const section = createHookRenderer(CodingNsSettingsSection, { settings, registry, services } as never)
  t.after(() => section.dispose())
  const cardElement = () => elements(section.render()).find(element => element.props.entry?.module === quickAppsFeature)!
  const card = createHookRenderer(cardElement().type as (props: any) => ReactElement, cardElement().props)
  t.after(() => card.dispose())
  const toggle = () => elements(card.render(cardElement().props)).find(element => typeof element.props.onChange === 'function')!
  assert.equal(toggle().props.checked, false)
  assert.equal(toggle().props.disabled, false)

  for (const enabled of [true, false]) {
    toggle().props.onChange(enabled)
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(JSON.parse(saved).modules.quickApps, enabled)
    assert.equal(settings.getSnapshot().value?.modules.quickApps, enabled)
    assert.equal(toggle().props.checked, enabled)
    assert.equal(elements(section.render()).some(element => element.props.role === 'alert'), false)
    assert.ok(elements(section.render()).some(element => element.props.role === 'status'))
    const reloaded = createCodingNsSettingsBridge(undefined, rpc)
    try {
      await reloaded.load()
      assert.equal(reloaded.getSnapshot().value?.modules.quickApps, enabled)
    } finally { reloaded.dispose() }
    assert.deepEqual(JSON.parse(saved).sessionTranslation, originalTranslation)
  }
  assert.equal(writes, 2)
  assert.equal(settings.getSnapshot().revision, 3)

  // Module enablement must not bypass the dedicated shortcut/grant management RPCs.
  for (const path of [['modules'], ['modules', 'auth'], ['modules', 'quickApps', 'grants'], ['quickApps'], ['quickApps', 'grants']]) {
    await assert.rejects(settings.mutate([{ op: 'set', path, value: true }]), { code: 'CODINGNS_SETTINGS_FIELD_FORBIDDEN' })
  }
  assert.equal(writes, 2, 'forbidden fields must never reach the settings provider')
})
