import assert from 'node:assert/strict'
import test from 'node:test'
import { AssistantAvatarManager } from '../data/build/dist/client/avatar/manager.js'
import { callCodingNsRpc, createCodingNsSettingsBridge } from '../data/build/dist/client/settings-bridge.js'
import { createConfigFormSettingsStore } from '../data/build/dist/dsh-capabilities/client/config-forms-adapter.js'
import { createCodingNsRpcHandler, createCodingNsSettingsRpcHandler } from '../data/build/dist/host/rpc.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../data/build/dist/shared/contracts/config.js'
import { DEFAULT_ASSISTANT_APPEARANCE } from '../data/build/dist/shared/assistant-avatar.js'
import { hasAssistantAvatarConsent } from '../data/build/dist/shared/assistant-avatar-catalog.js'
import type { CodingNsSettings } from '../src/shared/contracts/config.js'
import type { AssistantAppearanceSettings } from '../src/shared/assistant-avatar.js'
import type { CodingNsSettingsStore } from '../src/dsh-capabilities/settings-store.js'
import type { CodingNsRpcClient } from '../src/client/features/types.js'

const namespace = '@jingyi0605/codingns4dsh'
const model = { id: 'other-window', name: '另一窗口形象', renderer: 'image', source: '/pets/other.png', spriteVersion: 2 } as const
type SettingsResponse = { value: CodingNsSettings; revision: number }

/** 使用真实 Host RPC 解析与错误序列化，仅用内存替代配置文件和原生镜像。 */
function fixture(mode: 'remote' | 'form') {
  let value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  let revision = 48
  let beforeWrite: (() => void) | undefined
  let readFailure: Error | undefined
  const attempts: Array<number | undefined> = []
  const calls: string[] = []
  const initial = { value, revision, writable: true, status: 'ready' as const }
  const table = new CodingNsRpcTable()
  table.register('settings', createCodingNsSettingsRpcHandler({
    writable: true,
    describe: () => [{ ns: namespace, value, revision }],
    get: () => value,
    mutate: async (_namespace, operations, expectedRevision) => {
      attempts.push(expectedRevision)
      beforeWrite?.()
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw Object.assign(new Error(`settings namespace "${namespace}" changed since it was read (expected revision ${expectedRevision}, now ${revision})`),
          { name: 'SettingsConflictError', code: 'SETTINGS_CONFLICT' })
      }
      assert.deepEqual(operations.map((operation) => operation.path), [['assistant', 'appearance']])
      value = { ...value, assistant: { ...value.assistant, appearance: operations[0]!.value as AssistantAppearanceSettings } }
      revision++
    },
  }))
  const handler = createCodingNsRpcHandler(table)
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint, payload, signal) => {
    calls.push(endpoint)
    if (endpoint === 'settings/get' && readFailure !== undefined) throw readFailure
    return handler(endpoint, payload, signal ?? new AbortController().signal)
  } }
  const call = (endpoint: string, payload: unknown) => callCodingNsRpc<SettingsResponse>(rpc, endpoint, payload)
  const store = mode === 'remote' ? createCodingNsSettingsBridge(undefined, rpc) : createConfigFormSettingsStore({ get: () => ({
    getSnapshot: () => initial,
    subscribe: () => () => {},
    mutate: async () => { throw new Error('带版本校验的写入必须通过 Host RPC') },
    set: async () => false,
    unset: async () => false,
  }) }, namespace, {
    writeUnfenced: (ops) => call('settings/set', { ops }),
    writeFenced: (ops, expectedRevision) => call('settings/set', { ops, expectedRevision }),
    readLatest: () => call('settings/get', {}),
  })
  const manager = new AssistantAvatarManager(store)
  return {
    store, manager, attempts, calls,
    get: () => value,
    advance: (update: (current: CodingNsSettings) => CodingNsSettings, count = 2) => { value = update(value); revision += count },
    beforeWrite: (next: (() => void) | undefined) => { beforeWrite = next },
    failRead: (error: Error) => { readFailure = error },
  }
}

for (const mode of ['remote', 'form'] as const) {
  test(`${mode}：revision 48→50 后重新启用第三方形象，保留其他窗口形象及后台设置`, async () => {
    const f = fixture(mode)
    await f.store.load?.()
    f.advance((current) => ({ ...current, cliSessions: [{ sessionId: 'host-only' }] as never,
      assistant: { ...current.assistant, managedWorkspaceIds: ['other-workspace'],
        voice: { ...current.assistant.voice, modelId: 'other-voice' },
        appearance: { ...DEFAULT_ASSISTANT_APPEARANCE, selectedId: model.id, floatingSize: 220,
          models: [...DEFAULT_ASSISTANT_APPEARANCE.models, model] } } }))

    // 本管理器的后续写入必须排在重试完成后，不能再读取 revision 48。
    await Promise.all([f.manager.setThirdPartyEnabled(true), f.manager.configure({ dialogSize: 340 })])

    assert.deepEqual(f.attempts, [48, 50, 51])
    assert.equal(hasAssistantAvatarConsent(f.manager.getAppearance().thirdPartyConsent), true)
    assert.equal(f.manager.getSelected().id, model.id)
    assert.equal(f.manager.getAppearance().floatingSize, 220)
    assert.equal(f.manager.getAppearance().dialogSize, 340)
    assert.deepEqual(f.manager.getAppearance().models, f.get().assistant.appearance!.models)
    assert.equal(f.get().assistant.voice.modelId, 'other-voice')
    assert.deepEqual(f.get().assistant.managedWorkspaceIds, ['other-workspace'])
    assert.equal(f.get().cliSessions?.length, 1)
    assert.equal(f.store.getSnapshot().value?.cliSessions, undefined, 'Host 索引不能进入 Client 快照')
    assert.equal(f.calls.filter((endpoint) => endpoint === 'settings/get').length, mode === 'remote' ? 2 : 1)
  })
}

test('持续冲突最多写入三次，失败后队列仍可继续保存', async () => {
  const f = fixture('remote')
  await f.store.load?.()
  f.beforeWrite(() => f.advance((current) => current, 1))
  await assert.rejects(f.manager.setThirdPartyEnabled(true), /持续被其他操作更新/u)
  assert.equal(f.attempts.length, 3)
  assert.equal(f.calls.filter((endpoint) => endpoint === 'settings/get').length, 3)
  assert.equal(hasAssistantAvatarConsent(f.get().assistant.appearance?.thirdPartyConsent), false)
  f.beforeWrite(undefined)
  await f.manager.configure({ floatingEnabled: true })
  assert.equal(f.get().assistant.appearance?.floatingEnabled, true)
})

test('普通存储错误保留稳定错误码，不重读或重试', async () => {
  const f = fixture('remote')
  await f.store.load?.()
  f.beforeWrite(() => { throw Object.assign(new Error('storage unavailable'), { code: 'EIO' }) })
  await assert.rejects(f.manager.setThirdPartyEnabled(true), { message: 'storage unavailable', code: 'EIO' })
  assert.equal(f.attempts.length, 1)
  assert.deepEqual(f.calls, ['settings/get', 'settings/set'])
})

test('权威快照重读失败时直接报告，不使用旧配置继续写入', async () => {
  const f = fixture('remote')
  await f.store.load?.()
  f.advance((current) => current)
  f.failRead(new Error('refresh failed'))
  await assert.rejects(f.manager.setThirdPartyEnabled(true), /refresh failed/u)
  assert.equal(f.attempts.length, 1)
  assert.equal(hasAssistantAvatarConsent(f.get().assistant.appearance?.thirdPartyConsent), false)
})

test('旧 Host 仅透传冲突正文时仍能重算；普通拒绝不自动重试', async () => {
  let appearance = DEFAULT_ASSISTANT_APPEARANCE
  let revision = 48
  let writes = 0, reloads = 0, reject = false
  const store: CodingNsSettingsStore<CodingNsSettings> = {
    getSnapshot: () => ({ value: { ...DEFAULT_CODINGNS_SETTINGS, assistant: { ...DEFAULT_CODINGNS_SETTINGS.assistant, appearance } },
      revision, status: 'ready', writable: true }),
    subscribe: () => () => {}, set: async () => false, unset: async () => false,
    mutate: async (ops) => {
      writes++
      if (reject) return false
      if (revision === 48) throw new Error(`settings namespace "${namespace}" changed since it was read (expected revision 48, now 50)`)
      appearance = ops[0]!.value as AssistantAppearanceSettings
      revision++
      return true
    },
    reload: async () => { reloads++; revision = 50; appearance = { ...appearance, floatingSize: 230 } },
  }
  const manager = new AssistantAvatarManager(store)
  await manager.setThirdPartyEnabled(true)
  assert.equal(writes, 2); assert.equal(reloads, 1)
  assert.equal(manager.getAppearance().floatingSize, 230)
  assert.equal(hasAssistantAvatarConsent(manager.getAppearance().thirdPartyConsent), true)
  reject = true
  await assert.rejects(manager.setThirdPartyEnabled(false), /保存被拒绝/u)
  assert.equal(writes, 3); assert.equal(reloads, 1)
})

test('重读后重新校验清单，不能恢复其他窗口已删除的形象', async () => {
  const f = fixture('remote')
  f.advance((current) => ({ ...current, assistant: { ...current.assistant,
    appearance: { ...DEFAULT_ASSISTANT_APPEARANCE, models: [...DEFAULT_ASSISTANT_APPEARANCE.models, model] } } }))
  await f.store.load?.()
  f.advance((current) => ({ ...current, assistant: { ...current.assistant, appearance: DEFAULT_ASSISTANT_APPEARANCE } }))
  await assert.rejects(f.manager.select(model.id), /形象不在清单中/u)
  assert.equal(f.attempts.length, 1)
  assert.deepEqual(f.get().assistant.appearance, DEFAULT_ASSISTANT_APPEARANCE)
})
