import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeApprovalCatalog, nativeApprovalModeForValue, canChangeNativeApproval } from '../data/build/dist/client/native-approval-selector.js'
import { nativeApprovalModes, isNativeApprovalMode, resolveNativeApprovalPermission } from '../data/build/dist/shared/native-approval-modes.js'
import { zh } from '../data/build/dist/client/locales/nativeApproval.js'
import { CodingNsCliSessionStore } from '../data/build/dist/host/cli-adapters/session-store.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsSettingsSchema } from '../src/host/settings.js'

const driver = (id: string) => ({ descriptor: { id, name: id }, detect: async () => ({ installed: true, version: null, command: null }), async *executeTurn() {} })
const t = (key: string) => zh[key] ?? key

test('实际 UI 各自展示自动风险审批与完全访问；只支持 ZCode 的接受编辑不出现在 Codex', () => {
  assert.deepEqual(nativeApprovalModes('codex'), ['manual', 'auto-review', 'read-only', 'full-access-confirm', 'full-access'])
  assert.deepEqual(nativeApprovalModes('zcode'), ['manual', 'auto-review', 'read-only', 'accept-edits', 'full-access'])
  for (const adapterId of ['codex', 'zcode']) {
    const options = nativeApprovalCatalog(adapterId, t).options
    assert.equal(options.some(option => option.value === 'inherit' || option.name.includes('跟随')), false)
    assert.equal(nativeApprovalModeForValue(adapterId, 'inherit'), undefined)
    assert.equal(options.find(option => option.value === 'auto')?.name, t(adapterId === 'codex' ? 'nativeApproval.auto-review' : 'nativeApproval.zcodeAuto'))
    assert.ok(options.some(option => option.value === 'danger-full-access'))
    assert.equal(options.some(option => option.value === 'accept-edits'), adapterId === 'zcode')
    assert.equal(nativeApprovalModeForValue(adapterId, 'auto'), 'auto-review')
    assert.equal(nativeApprovalModeForValue(adapterId, 'danger-full-access'), 'full-access')
  }
  assert.deepEqual(nativeApprovalCatalog('agy', t).options, [])
  assert.deepEqual(nativeApprovalModes('dsh'), [])
  assert.equal(isNativeApprovalMode('zcode', 'auto'), false, 'ZCode 的 auto 未实现，不能开放')
  assert.equal(nativeApprovalModeForValue('codex', 'accept-edits'), undefined)
  assert.equal(isNativeApprovalMode('codex', 'accept-edits'), false)
  assert.equal(nativeApprovalModeForValue('codex', 'full-access-confirm'), 'full-access-confirm')
  for (const adapterId of ['zcode', 'antigravity', 'dsh']) assert.equal(isNativeApprovalMode(adapterId, 'full-access-confirm'), false)
})

test('已有会话运行中或有排队消息时仍可保存下一轮权限，未知状态不开放', () => {
  assert.equal(canChangeNativeApproval({ running: false }), true)
  assert.equal(canChangeNativeApproval({ running: true }), true)
  assert.equal(canChangeNativeApproval({ queue: [{}] }), true)
  assert.equal(canChangeNativeApproval(undefined), false)
})

test('显式模式覆盖 DSH 权限；旧跟随、缺省和未知值保留原有权限', () => {
  const inherited = { sandboxMode: 'read-only', approvalPolicy: 'never' } as const
  assert.deepEqual(resolveNativeApprovalPermission({ adapterId: 'codex', nativeApprovalMode: 'auto-review' }, inherited), {
    sandboxMode: 'workspace-write', approvalPolicy: 'ask', nativeApprovalMode: 'auto-review',
  })
  assert.deepEqual(resolveNativeApprovalPermission({ adapterId: 'zcode', nativeApprovalMode: 'auto-review' }, inherited), { approvalPolicy: 'ask', nativeApprovalMode: 'auto-review' })
  assert.deepEqual(resolveNativeApprovalPermission({ adapterId: 'codex', nativeApprovalMode: 'full-access-confirm' }, inherited), {
    sandboxMode: 'danger-full-access', approvalPolicy: 'ask', nativeApprovalMode: 'full-access-confirm',
  })
  assert.deepEqual(resolveNativeApprovalPermission({ adapterId: 'codex', nativeApprovalMode: 'full-access' }, inherited), {
    sandboxMode: 'danger-full-access', approvalPolicy: 'never', nativeApprovalMode: 'full-access',
  })
  for (const nativeApprovalMode of ['inherit', undefined, 'unknown'] as const) {
    for (const adapterId of ['codex', 'zcode']) {
      assert.equal(resolveNativeApprovalPermission({ adapterId, nativeApprovalMode } as never, inherited), inherited)
      assert.equal(resolveNativeApprovalPermission({ adapterId, nativeApprovalMode } as never, undefined), undefined)
    }
  }
  assert.equal(resolveNativeApprovalPermission({ adapterId: 'agy' }, inherited), inherited)
})

test('Codex full-access-confirm survives settings and session reload and stays isolated from other agents and children', async () => {
  const settings = CodingNsSettingsSchema({ agentAdapterPreferences: { codex: { nativeApprovalMode: 'full-access-confirm' } } })
  assert.equal(settings.agentAdapterPreferences.codex?.nativeApprovalMode, 'full-access-confirm')
  let records: any[] = []
  const store = new CodingNsCliSessionStore({ persistence: { async write(value) { records = [...value] } } })
  const registry = new CodingNsCliAdapterRegistry([driver('codex'), driver('zcode')] as never, {}, { sessionStore: store })
  const restored = new CodingNsCliSessionStore()
  const cold = new CodingNsCliAdapterRegistry([driver('codex'), driver('zcode')] as never, {}, { sessionStore: restored })
  try {
    registry.setSession('parent', { adapterId: 'codex', providerSessionId: 'original-thread', nativeApprovalMode: 'full-access-confirm' })
    await store.flush()
    restored.sync(records)
    assert.equal(cold.getSession('parent').nativeApprovalMode, 'full-access-confirm')
    assert.equal(cold.setSession('parent', { adapterId: 'codex', modelId: 'changed' }).providerSessionId, 'original-thread')
    assert.equal(cold.setSession('ordinary', { adapterId: 'codex' }).nativeApprovalMode, 'full-access-confirm')
    assert.equal(cold.setSession('child', { adapterId: 'codex', parentSessionId: 'parent', origin: 'subagent' }).nativeApprovalMode, undefined)
    assert.throws(() => cold.setSession('unsupported', { adapterId: 'zcode', nativeApprovalMode: 'full-access-confirm' }), /Unsupported/)
  } finally { await registry.dispose(); await cold.dispose() }
})

test('模式冷恢复、模型更新、旧跟随迁移；新建会话按 Agent 继承权限，保留 native ID', async () => {
  let records: any[] = []
  const store = new CodingNsCliSessionStore({ persistence: { async write(value) { records = [...value] } } })
  const registry = new CodingNsCliAdapterRegistry([driver('codex'), driver('zcode')] as never, {}, { sessionStore: store })
  registry.setSession('s', { adapterId: 'codex', providerSessionId: 'thread-original', nativeApprovalMode: 'auto-review' })
  registry.setSession('s', { adapterId: 'codex', modelId: 'next-model' })
  await store.flush()
  const reloaded = new CodingNsCliSessionStore()
  reloaded.sync(records)
  const cold = new CodingNsCliAdapterRegistry([driver('codex'), driver('zcode')] as never, {}, { sessionStore: reloaded })
  assert.equal(cold.getSession('s').nativeApprovalMode, 'auto-review')
  assert.equal(cold.setSession('s', { adapterId: 'codex', nativeApprovalMode: 'manual' }).providerSessionId, 'thread-original')
  assert.equal(cold.setSession('s', { adapterId: 'codex', nativeApprovalMode: 'inherit' }).nativeApprovalMode, 'inherit')
  assert.equal(cold.setSession('new', { adapterId: 'codex' }).nativeApprovalMode, 'inherit')
  assert.equal(cold.setSession('s', { adapterId: 'zcode' }).nativeApprovalMode, undefined)
  assert.equal(cold.getSession('s').providerSessionId, undefined)
  assert.throws(() => cold.setSession('s', { adapterId: 'zcode', nativeApprovalMode: 'auto' } as never), /Unsupported/)
})


test('cold legacy sessions and model-only edits cannot inherit a newer full-access preference', async () => {
  for (const adapterId of ['codex', 'zcode']) {
    const store = new CodingNsCliSessionStore()
    store.upsert('old', { adapterId })
    const registry = new CodingNsCliAdapterRegistry([driver(adapterId)] as never, {}, { sessionStore: store })
    try {
      registry.setSession('new-choice', { adapterId, nativeApprovalMode: 'full-access' })
      const old = registry.setSession('old', { adapterId, modelId: 'changed-model' })
      assert.equal(old.nativeApprovalMode, undefined)
      assert.deepEqual(resolveNativeApprovalPermission(old, { sandboxMode: 'read-only', approvalPolicy: 'ask' }), { sandboxMode: 'read-only', approvalPolicy: 'ask' })
      assert.equal(registry.setSession('child', { adapterId, parentSessionId: 'new-choice', origin: 'subagent' }).nativeApprovalMode, undefined)
      assert.equal(registry.setSession('ordinary-new', { adapterId }).nativeApprovalMode, 'full-access')
    } finally { await registry.dispose() }
  }
})
