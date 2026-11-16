import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { AntigravityDriver } from '../src/host/cli-adapters/antigravity-driver.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { CodingNsCliSessionStore } from '../src/host/cli-adapters/session-store.js'
import { nativeApprovalModes, resolveNativeApprovalMode, resolveNativeApprovalPermission } from '../src/shared/native-approval-modes.js'
import { nativeApprovalCatalog, nativeApprovalModeForValue } from '../src/client/native-approval-selector.js'
import { registerCliConversationSlots } from '../src/client/cli-slots.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { zh } from '../src/client/locales/nativeApproval.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { createPresentationSlots } from './fixtures/presentation-slots.js'

const t = (key: string) => zh[key] ?? key
const result = { event: 'result', result: { conversation_id: 'agy-permissions', status: 'SUCCESS', response: '完成' } }
const denial = 'permission check failed for unsandboxed "Get-ChildItem": user denied permission to run command'

function fixture(events: Record<string, unknown>[], stderrText = '') {
  const calls: string[][] = []
  const driver = new AntigravityDriver({
    binaries: ['fixture-agy'], resolveContextWindow: () => undefined, resolveModelId: () => null,
    spawnSync: (() => ({ status: 0, stdout: 'agy 1.5.9', stderr: '' })) as never,
    spawn: ((_command: string, args: string[]) => {
      calls.push(args)
      const stdout = new PassThrough(), stderr = new PassThrough()
      return { stdout, stderr, kill() { return true }, stdin: { end() {
        queueMicrotask(() => {
          if (stderrText) stderr.write(stderrText)
          for (const event of events) stdout.write(JSON.stringify(event) + '\n')
          stdout.end(); stderr.end()
        })
      } } }
    }) as never,
  })
  return { driver, calls }
}

const collect = async (driver: AntigravityDriver, input: Record<string, unknown> = {}) => {
  const events: any[] = []
  for await (const event of driver.executeTurn({ sessionId: 'agy-permissions', messages: [], prompt: 'test', ...input } as never)) events.push(event)
  return events
}

test('AGY exposes its four native modes, defaults to plan, and does not claim interactive approval', () => {
  assert.deepEqual(nativeApprovalModes('antigravity'), ['auto-review', 'read-only', 'accept-edits', 'full-access'])
  assert.equal(resolveNativeApprovalMode('antigravity', undefined), 'read-only')
  assert.equal(resolveNativeApprovalMode('antigravity', 'inherit'), 'read-only')
  const options = nativeApprovalCatalog('antigravity', t).options
  assert.deepEqual(options.map(option => option.value), ['auto', 'read-only', 'accept-edits', 'danger-full-access'])
  assert.equal(options[1]?.name, '规划')
  assert.match(options[0]!.description, /沙箱/)
  assert.match(options[2]!.description, /命令.*审批/)
  assert.match(options[3]!.description, /agy/)
  assert.equal(nativeApprovalModeForValue('antigravity', 'manual'), undefined)
})

test('AGY native permission choice reaches the actual CLI argv, independent of DSH inherited permissions', async () => {
  for (const [mode, args] of [
    ['auto-review', ['--mode', 'auto']], ['read-only', ['--mode', 'plan']],
    ['accept-edits', ['--mode', 'accept-edits']], ['full-access', ['--dangerously-skip-permissions']],
  ] as const) {
    const { driver, calls } = fixture([result])
    try {
      const permission = resolveNativeApprovalPermission({ adapterId: 'antigravity', nativeApprovalMode: mode }, { sandboxMode: 'read-only', approvalPolicy: 'ask' })
      await collect(driver, { permission })
      const index = calls[0]!.indexOf(args[0])
      assert.notEqual(index, -1, mode)
      assert.deepEqual(calls[0]!.slice(index, index + args.length), args)
      if (mode !== 'full-access') assert.equal(calls[0]!.includes('--dangerously-skip-permissions'), false)
      if (mode === 'accept-edits') assert.equal(permission?.approvalPolicy, 'ask', 'shell approval remains required')
      if (mode !== 'full-access') assert.notEqual(permission?.sandboxMode, 'danger-full-access')
    } finally { driver.dispose() }
  }
})

test('AGY legacy defaults stay conservative and never inherit full access without a native choice', () => {
  const permission = resolveNativeApprovalPermission({ adapterId: 'antigravity' }, { sandboxMode: 'danger-full-access', approvalPolicy: 'never' })
  assert.equal(permission?.nativeApprovalMode, 'read-only')
  assert.notEqual(permission?.sandboxMode, 'danger-full-access')
})

test('AGY screenshot denial becomes a failed tool and an actionable error, even when CLI reports SUCCESS', async () => {
  const { driver } = fixture([
    { event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, state: 'DONE', usage: { input_tokens: 100, output_tokens: 10 } } },
    { event: 'step_update', step_update: { step_type: 'tool', step_index: 2, state: 'DONE', tool_name: 'run_command', tool_info: { error: { type: 'TOOL_ERROR', message: denial } } } },
    result,
  ])
  try {
    const events = await collect(driver)
    assert.equal(events.find(event => event.type === 'tool-event')?.status, 'failed')
    const finish = events.filter(event => event.type === 'finish')
    assert.equal(finish.length, 1)
    assert.equal(finish[0].reason, 'error')
    assert.equal(finish[0].failure.code, 'AGY_PERMISSION_DENIED')
    assert.match(finish[0].failure.message, /无头|非交互/)
    assert.match(finish[0].failure.message, /permissions/)
    assert.equal(events.some(event => event.type === 'text-delta' && event.text === '完成'), false)
    assert.equal(events.find(event => event.type === 'usage')?.inputTokens, 100)
  } finally { driver.dispose() }
})

test('AGY stderr soft-denial is surfaced when stdout otherwise looks successful', async () => {
  const { driver } = fixture([result], 'Print mode: soft-denying tool confirmation "Bash" at step 10\n')
  try {
    const events = await collect(driver)
    const finish = events.find(event => event.type === 'finish')
    assert.equal(finish.reason, 'error')
    assert.equal(finish.failure.code, 'AGY_PERMISSION_DENIED')
    assert.equal(events.some(event => event.type === 'text-delta' && event.text === '完成'), false)
  } finally { driver.dispose() }
})

test('AGY terminal permission errors are actionable, while cancellation still wins', async () => {
  const failed = fixture([{ event: 'result', result: { status: 'ERROR', error: denial } }])
  try {
    assert.equal((await collect(failed.driver)).find(event => event.type === 'finish')?.failure?.code, 'AGY_PERMISSION_DENIED')
  } finally { failed.driver.dispose() }
  const cancelled = fixture([result], 'soft-denying tool confirmation "Bash"')
  try {
    const controller = new AbortController(); controller.abort()
    await assert.rejects(() => collect(cancelled.driver, { signal: controller.signal }), /abort/iu)
  } finally { cancelled.driver.dispose() }
})

test('AGY auto-mode fallback is reported instead of silently running with default permissions', async () => {
  const { driver, calls } = fixture([result], 'Warning: auto mode is not available because the terminal sandbox is unavailable; continuing in default mode\n')
  try {
    const permission = resolveNativeApprovalPermission({ adapterId: 'antigravity', nativeApprovalMode: 'auto-review' }, undefined)
    const finish = (await collect(driver, { permission })).find(event => event.type === 'finish')
    assert.equal(finish.reason, 'error')
    assert.equal(finish.failure.code, 'AGY_AUTO_MODE_UNAVAILABLE')
    assert.match(finish.failure.message, /沙箱/)
    assert.equal(calls[0]!.includes('--dangerously-skip-permissions'), false)
  } finally { driver.dispose() }
})

test('AGY ordinary tool errors and prose mentioning permissions do not become permission failures', async () => {
  const { driver } = fixture([
    { event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'read_file', tool_info: { error: { type: 'TOOL_ERROR', message: 'ENOENT' } } } },
    { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: denial } }, result,
  ])
  try {
    const events = await collect(driver)
    assert.equal(events.find(event => event.type === 'tool-event')?.status, 'failed')
    assert.equal(events.find(event => event.type === 'finish')?.reason, 'stop')
  } finally { driver.dispose() }
})

test('AGY saved modes survive cold reload without losing provider session identity', async () => {
  let records: any[] = []
  const store = new CodingNsCliSessionStore({ persistence: { async write(value) { records = [...value] } } })
  const descriptor = { id: 'antigravity', name: 'Antigravity' }
  const makeRegistry = (sessionStore: CodingNsCliSessionStore) => new CodingNsCliAdapterRegistry([{ descriptor, async *executeTurn() {} }] as never, {}, { sessionStore })
  const registry = makeRegistry(store)
  try {
    registry.setSession('s', { adapterId: 'antigravity', providerSessionId: 'existing', nativeApprovalMode: 'accept-edits' })
    await store.flush()
    const coldStore = new CodingNsCliSessionStore(); coldStore.sync(records)
    const cold = makeRegistry(coldStore)
    try {
      assert.equal(cold.getSession('s').nativeApprovalMode, 'accept-edits')
      assert.equal(cold.setSession('s', { adapterId: 'antigravity', nativeApprovalMode: 'full-access' }).providerSessionId, 'existing')
      assert.equal(cold.setSession('new', { adapterId: 'antigravity' }).nativeApprovalMode, 'full-access')
      assert.throws(() => cold.setSession('s', { adapterId: 'antigravity', nativeApprovalMode: 'manual' }), /Unsupported/)
    } finally { await cold.dispose() }
  } finally { await registry.dispose() }
})

test('AGY denied tool terminates through the real Registry step boundary without starting another CLI process', async () => {
  const { driver, calls } = fixture([
    { event: 'step_update', step_update: { step_type: 'tool', step_index: 2, state: 'DONE', tool_name: 'run_command', tool_info: { error: { type: 'TOOL_ERROR', message: denial } } } }, result,
  ])
  const registry = new CodingNsCliAdapterRegistry([driver])
  const config = { adapterId: 'antigravity', nativeApprovalMode: 'accept-edits' } as const
  registry.setSession('agy-permissions', config)
  const input = { adapterId: 'antigravity', sessionId: 'agy-permissions', messages: [], prompt: 'same user turn', splitToolSteps: true, permission: resolveNativeApprovalPermission(config, undefined)! }
  const events: any[] = []
  try {
    for (let step = 0; step < 3 && !events.some(event => event.type === 'finish'); step += 1) {
      for await (const event of registry.execute(input)) events.push(event)
    }
    assert.equal(calls.length, 1)
    assert.equal(events.filter(event => event.type === 'step-boundary').length, 1)
    assert.equal(events.find(event => event.type === 'finish')?.failure?.code, 'AGY_PERMISSION_DENIED')
  } finally { await registry.dispose() }
})

test('AGY changing permission during a turn preserves the running snapshot and applies the next turn', async () => {
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const received: any[] = []
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'antigravity', name: 'Antigravity' },
    async *executeTurn(input: any) {
      received.push(input.permission)
      if (received.length === 1) { entered(); await gate; yield { type: 'session-binding', providerSessionId: 'existing' } as const }
      yield { type: 'finish', reason: 'stop' } as const
    },
  }] as never)
  const drain = async (stream: AsyncIterable<unknown>) => { for await (const _event of stream) {} }
  registry.setSession('running-agy', { adapterId: 'antigravity', nativeApprovalMode: 'accept-edits' })
  const initial = resolveNativeApprovalPermission(registry.getSession('running-agy'), undefined)!
  const input = { adapterId: 'antigravity', sessionId: 'running-agy', messages: [], prompt: 'first', permission: initial }
  const running = drain(registry.execute(input))
  try {
    await started
    registry.setSession('running-agy', { adapterId: 'antigravity', nativeApprovalMode: 'full-access' })
    release(); await running
    assert.deepEqual(received[0], initial)
    assert.equal(registry.getSession('running-agy').nativeApprovalMode, 'full-access')
    const next = resolveNativeApprovalPermission(registry.getSession('running-agy'), undefined)!
    await drain(registry.execute({ ...input, prompt: 'next', permission: next }))
    assert.equal(received[1].nativeApprovalMode, 'full-access')
  } finally { release(); await running; await registry.dispose() }
})

test('AGY actual native permission slot offers its modes and saves while a turn is active', async () => {
  const locale = { bind: () => resolveCodingNsTranslator(), getSnapshot: () => ({ revision: 0 }), subscribe: () => () => {}, register: () => () => {} } as never
  const slots = createPresentationSlots()
  const removeRoot = slots.register({ name: 'root', children: { 'conversation.input.left': { kind: 'list', scope: 'session' }, 'conversation.input.permission': { kind: 'single', scope: 'session' } } } as any, () => null)
  const removeNative = slots.register({ name: 'conversation.input.permission' } as any, () => null)
  let selection: any = { adapterId: 'antigravity', providerSessionId: 'existing' }
  const rpc = { async call(_channel: string, endpoint: string, payload: any) { if (endpoint === 'cli/session/set') selection = { ...selection, ...payload }; return { ok: true, value: selection } } }
  const dispose = registerCliConversationSlots(slots as never, rpc as never, locale)
  const slot: any = slots.entries('conversation.input.permission').find(entry => entry.options.id === 'codingns4dsh-native-approval')!
  const mounted = slot.component({ ...slot.inject('agy-permission-ui'), t: (key: string) => key, useSession: (select: any) => select({ sessionId: 'agy-permission-ui', running: true, queue: [] }) })
  const renderer = createHookRenderer(mounted.type, mounted.props, { checkHookOrder: true })
  try {
    renderer.render(); await new Promise(resolve => setImmediate(resolve))
    const tree: any = renderer.render()
    assert.equal(tree.props['data-codingns-approval'], 'override')
    assert.equal(tree.props['data-codingns-approval-applies'], 'next-turn')
    const control = tree.props.children[0]
    assert.match(control.props.t('confirm.description'), /agy/)
    assert.equal(control.props.useProjection('permissions').currentValue, 'read-only')
    assert.equal(control.props.usePermissionCatalog((state: any) => state).value.options.length, 4)
    assert.equal(await control.props.select('manual'), false)
    assert.equal(await control.props.select('accept-edits'), true)
    assert.equal(selection.nativeApprovalMode, 'accept-edits')
    assert.equal(selection.providerSessionId, 'existing')
  } finally { renderer.dispose(); dispose(); removeNative(); removeRoot() }
})
