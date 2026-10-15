import assert from 'node:assert/strict'
import test from 'node:test'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { ConversationTranslationSettings } from '../src/client/conversation-translation-settings.js'
import { SettingsToggleRow } from '../src/client/settings-controls.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS, normalizeSessionTranslationSettings, resolveSessionTranslationOptions, type SessionTranslationSettings } from '../src/shared/contracts/session-translation.js'
import { CodingNsSettingsSchema } from '../src/host/settings.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { createCodingNsSettingsBridge } from '../src/client/settings-bridge.js'
import { createCodingNsSettingsRpcHandler } from '../src/host/rpc.js'
import type { CodingNsSettingsOperation } from '../src/dsh-capabilities/settings-store.js'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
function elements(node: ReactNode): ReactElement<any>[] {
  return isValidElement<{ children?: ReactNode }>(node)
    ? [node, ...Children.toArray(node.props.children).flatMap(elements)] : []
}

function applyOperations(value: unknown, operations: readonly CodingNsSettingsOperation[]): any {
  const next = structuredClone(value) as any
  for (const operation of operations) {
    let target = next
    for (const key of operation.path.slice(0, -1)) target = target[key] ??= {}
    target[operation.path.at(-1)!] = operation.value
  }
  return next
}

function fixture(translationPatch: Partial<SessionTranslationSettings> = {}) {
  const store = {
    snapshot: {
      value: { ...DEFAULT_CODINGNS_SETTINGS, sessionTranslation: {
        ...DEFAULT_SESSION_TRANSLATION_SETTINGS, inputEnabled: undefined,
        reasoningEnabled: undefined, assistantEnabled: undefined,
        translationRules: ['Keep names.'], translationModels: [{ provider: 'test', model: 'model' }],
        ...translationPatch,
      } }, status: 'ready', writable: true, revision: 1,
    },
    listeners: new Set<() => void>(),
    writes: [] as any[],
    accepted: true,
    // Method receivers deliberately match the real settings bridge.
    getSnapshot() { return this.snapshot },
    subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
    async mutate(operations: any[]) {
      this.writes.push(...operations)
      if (!this.accepted) return false
      const persisted = CodingNsSettingsSchema(applyOperations(this.snapshot.value, operations))
      this.snapshot = { ...this.snapshot, value: persisted as any, revision: this.snapshot.revision + 1 }
      for (const listener of this.listeners) listener()
      return true
    },
  }
  const props = { settings: store as never, adapterId: 'codex', t: resolveCodingNsTranslator(), onClose: () => {} }
  const renderer = createHookRenderer(ConversationTranslationSettings, props)
  return { store, renderer, rows: (adapterId = 'codex') => elements(renderer.render({ ...props, adapterId })).filter(element => element.type === SettingsToggleRow) }
}

test('message switches default on and persist independently while preserving other translation settings', async t => {
  const f = fixture()
  t.after(() => f.renderer.dispose())
  assert.equal(f.rows().length, 3)
  assert.ok(f.rows().every(row => row.props.checked && !row.props.disabled))
  for (const [index, field] of ['inputEnabled', 'reasoningEnabled', 'assistantEnabled'].entries()) {
    f.rows()[index]!.props.onChange(false)
    assert.ok(f.rows().every(row => row.props.disabled))
    await flush()
    assert.equal(f.rows()[index]!.props.checked, false)
    assert.deepEqual(f.store.writes.at(-1), { op: 'set', path: ['sessionTranslation', 'adapterOptions', 'codex', field], value: false })
  }
  const saved = JSON.parse(JSON.stringify(f.store.snapshot.value))
  const reloaded = CodingNsSettingsSchema(saved).sessionTranslation
  assert.deepEqual(resolveSessionTranslationOptions(reloaded, 'codex'), { inputEnabled: false, reasoningEnabled: false, assistantEnabled: false })
  assert.deepEqual(resolveSessionTranslationOptions(reloaded, 'claude-code'), { inputEnabled: true, reasoningEnabled: true, assistantEnabled: true })
  assert.deepEqual(reloaded.translationRules, ['Keep names.'])
  assert.deepEqual(reloaded.translationModels, [{ provider: 'test', model: 'model' }])
  assert.equal(reloaded.inputLanguage, 'en')
  assert.equal(reloaded.outputLanguage, 'zh')
  f.rows()[1]!.props.onChange(true)
  await flush()
  assert.deepEqual(f.rows().map(row => row.props.checked), [false, true, false])
})

test('switching agents keeps independent options and preserves legacy defaults after reload', async t => {
  const f = fixture({ inputEnabled: false, reasoningEnabled: false, assistantEnabled: true })
  t.after(() => f.renderer.dispose())
  assert.deepEqual(f.rows().map(row => row.props.checked), [false, false, true])
  f.rows()[0]!.props.onChange(true)
  await flush()
  assert.deepEqual(f.rows('claude-code').map(row => row.props.checked), [false, false, true])
  f.rows('claude-code')[1]!.props.onChange(true)
  await flush()
  assert.deepEqual(f.rows('dsh').map(row => row.props.checked), [false, false, true])
  f.rows('dsh')[2]!.props.onChange(false)
  await flush()
  assert.deepEqual(f.rows().map(row => row.props.checked), [true, false, true])
  assert.deepEqual(f.rows('claude-code').map(row => row.props.checked), [false, true, true])
  const reloaded = normalizeSessionTranslationSettings(CodingNsSettingsSchema(JSON.parse(JSON.stringify(f.store.snapshot.value))).sessionTranslation)
  for (const [adapterId, expected] of [
    ['codex', [true, false, true]], ['claude-code', [false, true, true]],
    ['dsh', [false, false, false]], ['gemini', [false, false, true]],
  ] as const) {
    assert.deepEqual(Object.values(resolveSessionTranslationOptions(reloaded, adapterId)), expected, adapterId)
  }
})

test('rejected writes keep saved values and report failure; unavailable settings cannot be changed', async t => {
  const f = fixture()
  t.after(() => f.renderer.dispose())
  f.store.accepted = false
  f.rows()[0]!.props.onChange(false)
  f.rows()[1]!.props.onChange(false)
  await flush()
  assert.equal(f.store.writes.length, 1)
  assert.ok(f.rows().every(row => row.props.checked && !row.props.disabled))
  assert.ok(elements(f.renderer.render()).some(element => element.props.role === 'alert'))
  for (const patch of [{ writable: false }, { writable: true, status: 'loading' }, { status: 'unavailable' }]) {
    f.store.snapshot = { ...f.store.snapshot, ...patch }
    assert.ok(f.rows().every(row => row.props.disabled))
    f.rows()[0]!.props.onChange(false)
    assert.equal(f.store.writes.length, 1)
  }
})

test('the dialog saves all three switches through the host RPC and preserves its field restrictions', async t => {
  let persisted = CodingNsSettingsSchema({ sessionTranslation: {
    translationRules: ['Keep names.'], translationModels: [{ provider: 'test', model: 'model' }],
  } } as never)
  let revision = 1
  let writes = 0
  const handler = createCodingNsSettingsRpcHandler({
    writable: true,
    describe: () => [{ ns: 'codingns', revision }],
    get: () => persisted,
    async mutate(namespace: string, operations: readonly CodingNsSettingsOperation[]) {
      assert.equal(namespace, 'codingns')
      for (const operation of operations) {
        assert.equal(operation.path[0], 'sessionTranslation')
      }
      persisted = CodingNsSettingsSchema(applyOperations(persisted, operations))
      revision++
      writes++
    },
  } as never)
  const bridge = createCodingNsSettingsBridge(undefined, {
    async call(_channel, endpoint, payload) {
      assert.ok(endpoint.startsWith('settings/'))
      return { ok: true, value: await handler(endpoint.slice('settings/'.length), payload) }
    },
  })
  await bridge.load()
  const renderer = createHookRenderer(ConversationTranslationSettings, {
    settings: bridge, adapterId: 'codex', t: resolveCodingNsTranslator(), onClose: () => {},
  })
  t.after(() => { renderer.dispose(); bridge.dispose() })
  const rows = () => elements(renderer.render()).filter(element => element.type === SettingsToggleRow)
  assert.deepEqual(rows().map(row => row.props.checked), [true, true, true])
  const fields = ['inputEnabled', 'reasoningEnabled', 'assistantEnabled'] as const
  for (const checked of [false, true]) {
    for (const [index, field] of fields.entries()) {
      rows()[index]!.props.onChange(checked)
      await flush()
      assert.equal(persisted.sessionTranslation.adapterOptions.codex?.[field], checked, field)
      assert.equal(rows()[index]!.props.checked, checked)
      assert.equal(elements(renderer.render()).some(element => element.props.role === 'alert'), false)
    }
  }
  assert.equal(writes, 6)
  assert.equal(bridge.getSnapshot().revision, 7)
  assert.deepEqual(persisted.sessionTranslation.translationRules, ['Keep names.'])
  assert.deepEqual(persisted.sessionTranslation.translationModels, [{ provider: 'test', model: 'model' }])
  assert.equal(persisted.sessionTranslation.inputLanguage, 'en')
  assert.equal(persisted.sessionTranslation.outputLanguage, 'zh')
  for (const path of [
    ['sessionTranslation', 'unknownField'],
    ['sessionTranslation', 'assistantEnabled', 'nested'],
    ['sessionTranslation', 'adapterOptions', 'unknown-agent', 'inputEnabled'],
    ['sessionTranslation', 'adapterOptions', 'codex', 'unknownField'],
    ['sessionTranslation', 'adapterOptions', 'codex'],
    ['sessionTranslation', 'adapterOptions', 'constructor', 'inputEnabled'],
    ['cliSessions'],
  ]) {
    await assert.rejects(bridge.mutate([{ op: 'set', path, value: false }]), /禁止修改设置字段/u)
  }
  assert.equal(writes, 6, 'forbidden paths must not reach the settings provider')
})
