import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate, setTimeout as delay } from 'node:timers/promises'
import { isValidElement, type ReactElement } from 'react'
import { CliManagementDialog, ManagementStatus, cliManagementAction, type CliManagementDialogProps } from '../src/client/cli-management-dialog.js'
import { CliManagementTerminal } from '../src/client/cli-management-terminal.js'
import { createCliSettingsRpc } from '../src/client/cli-settings-rpc.js'
import { callCliRpc } from '../src/client/cli-catalog.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import type { CodingNsCliAdapterDescriptor } from '../src/shared/contracts/cli-adapter.js'
import type { CliManagementOperation, CliManagementPlan } from '../src/shared/contracts/cli-management.js'
import type { CodingNsRpcClient } from '../src/client/features/types.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const t = resolveCodingNsTranslator()
const adapter: CodingNsCliAdapterDescriptor = { id: 'codex', name: 'Codex', installed: false, enabled: false, command: null, version: null, detectionState: 'ready' }
const plan: CliManagementPlan = { adapter, action: 'install', platform: 'linux', sourceUrl: 'https://developers.openai.com/codex/cli/', fingerprint: 'reviewed', methods: [{ id: 'npm', label: 'npm', command: 'npm install -g @openai/codex@latest', instructions: 'Requires npm', executable: true }, { id: 'manual', label: 'Official guide', command: null, instructions: 'Use the official guide', executable: false }] }
function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  return isValidElement(node) ? [node, ...elements((node.props as any).children)] : []
}
const button = (node: unknown, text: string) => elements(node).find(e => e.type === 'button' && e.props.children === text)
const text = (node: unknown): string => Array.isArray(node) ? node.map(text).join(' ') : isValidElement(node) ? text((node.props as any).children) : typeof node === 'string' ? node : ''
async function flush(view: ReturnType<typeof createHookRenderer<CliManagementDialogProps, ReactElement>>) { await setImmediate(); view.render(); await setImmediate(); return view.render() }

test('Install needs settled detection and Update needs a confirmed newer release', () => {
  assert.equal(cliManagementAction(adapter), 'install')
  assert.equal(cliManagementAction({ ...adapter, installed: true, runtimeState: 'installed' }), null)
  for (const state of ['checking', 'current', 'error', 'unavailable'] as const) {
    assert.equal(cliManagementAction({ ...adapter, installed: true, update: { state, latestVersion: '2.0.0' } }), null)
  }
  assert.equal(cliManagementAction({ ...adapter, installed: true, update: { state: 'available' } }), null)
  assert.equal(cliManagementAction({ ...adapter, installed: true, runtimeState: 'installed', update: { state: 'available', latestVersion: '2.0.0' } }), 'update')
  for (const detectionState of ['pending', 'running', 'error'] as const) assert.equal(cliManagementAction({ ...adapter, detectionState }), null)
  assert.equal(cliManagementAction({ ...adapter, detectionFailure: 'launch' }), null)
})

test('local management requests carry explicit Host scope; remote requests never get sent', async () => {
  const calls: unknown[] = []
  const rpc: CodingNsRpcClient = { call: async (_channel, _endpoint, payload) => { calls.push(payload); return { ok: true, value: null } } }
  await callCliRpc(createCliSettingsRpc(rpc, null), 'management/status', {})
  assert.deepEqual(calls, [{ catalogHostId: 'local' }])
  await assert.rejects(callCliRpc(createCliSettingsRpc(rpc, 'peer-a'), 'management/start', { adapterId: 'codex' }), /只支持查看和刷新/u)
  assert.equal(calls.length, 1)
})

test('dialog previews before starting and reports verified completion with automatic catalog refresh', async context => {
  const calls: { endpoint: string; payload: any }[] = []
  let operation: CliManagementOperation | null = null
  let changes = 0
  let completed: CliManagementOperation | undefined
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint, payload) => {
    calls.push({ endpoint, payload })
    if (endpoint === 'cli/management/plan') return { ok: true, value: { ...plan, action: (payload as { action: string }).action } }
    if (endpoint === 'cli/management/start') operation = { id: 'job', adapterId: 'codex', action: 'install', state: 'running', output: '' }
    return { ok: true, value: operation }
  } }
  const view = createHookRenderer(CliManagementDialog, { adapter, rpc, hostLabel: 'Local', t, onClose() {}, onCatalogChanged(result) { changes += 1; completed = result } })
  context.after(() => view.dispose())
  view.render(); let output = await flush(view)
  assert.equal(calls.some(c => c.endpoint.endsWith('/start')), false)
  assert.equal(elements(output).some(e => e.type === 'select'), false, 'installation also uses a Host-selected default')
  assert.ok(elements(output).some(e => e.type === 'pre' && e.props.children === plan.methods[0]!.command))
  button(output, t('cli.manage.run', { action: t('cli.manage.install') }))!.props.onClick()
  button(output, t('cli.manage.run', { action: t('cli.manage.install') }))!.props.onClick()
  output = await flush(view)
  assert.deepEqual(calls.find(c => c.endpoint.endsWith('/start'))!.payload, { adapterId: 'codex', action: 'install', methodId: 'npm', fingerprint: 'reviewed' })
  assert.equal(calls.filter(c => c.endpoint.endsWith('/start')).length, 1)
  assert.ok(button(output, t('cli.manage.cancel')))
  operation = { ...operation!, state: 'succeeded', adapter: { ...adapter, installed: true, version: '2.0.0' } }
  await delay(800); output = await flush(view)
  assert.equal(changes, 1)
  assert.equal(completed?.adapter?.version, '2.0.0')
  assert.equal(elements(output).find(e => e.type === ManagementStatus)!.props.operation.state, 'succeeded')
  assert.ok(text(output).includes(t('cli.manage.catalog.refreshed')))
  assert.equal(button(output, t('cli.manage.reviewAgain')), undefined)
  assert.equal(button(output, t('cli.manage.redetect')), undefined)
  assert.equal(button(output, t('cli.manage.run', { action: t('cli.manage.install') })), undefined)
  await flush(view)
  assert.equal(changes, 1, 'completion refresh runs once per operation')
})

test('unrecognized updates show guidance without a method chooser or a guessed command', async context => {
  const installed = { ...adapter, installed: true }
  const calls: string[] = []
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint) => {
    calls.push(endpoint)
    return { ok: true, value: endpoint.endsWith('/plan') ? { ...plan, adapter: installed, action: 'update' } : null }
  } }
  const view = createHookRenderer(CliManagementDialog, { adapter: installed, rpc, hostLabel: 'Local', t, onClose() {}, onCatalogChanged() {} })
  context.after(() => view.dispose())
  view.render(); const output = await flush(view)
  assert.equal(button(output, t('cli.manage.run', { action: t('cli.manage.update') })), undefined)
  assert.equal(elements(output).some(e => e.type === 'select'), false)
  assert.ok(text(output).includes(t('cli.manage.methodUnknown')))
  assert.equal(calls.some(endpoint => endpoint.endsWith('/start')), false)
  assert.ok(elements(output).some(e => e.type === 'a' && e.props.href === plan.sourceUrl))
})

test('install preview uses the Host default even when it is not the first method', async context => {
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint, payload) => {
    if (endpoint.endsWith('/plan')) return { ok: true, value: { ...plan, automaticMethodId: 'installer', methods: [...plan.methods, { ...plan.methods[0], id: 'installer', command: 'official installer' }] } }
    if (endpoint.endsWith('/start')) assert.equal((payload as any).methodId, 'installer')
    return { ok: true, value: null }
  } }
  const view = createHookRenderer(CliManagementDialog, { adapter, rpc, hostLabel: 'Local', t, onClose() {}, onCatalogChanged() {} })
  context.after(() => view.dispose())
  view.render(); const output = await flush(view)
  assert.equal(elements(output).some(e => e.type === 'select'), false)
  assert.ok(text(output).includes('official installer'))
  button(output, t('cli.manage.run', { action: t('cli.manage.install') }))!.props.onClick()
  await flush(view)
})

test('app-owned updates show official guidance without an unidentified-method warning', async context => {
  const installed = { ...adapter, id: 'zcode', name: 'ZCode', installed: true }
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint) => ({ ok: true, value: endpoint.endsWith('/plan')
    ? { ...plan, action: 'update', adapter: installed, methods: [{ id: 'manual', executable: false, command: null, instructions: 'Update inside ZCode.' }] } : null }) }
  const view = createHookRenderer(CliManagementDialog, { adapter: installed, rpc, hostLabel: 'Local', t, onClose() {}, onCatalogChanged() {} })
  context.after(() => view.dispose())
  view.render(); const output = await flush(view)
  assert.ok(text(output).includes('Update inside ZCode.'))
  assert.equal(text(output).includes(t('cli.manage.methodUnknown')), false)
  assert.equal(button(output, t('cli.manage.run', { action: t('cli.manage.update') })), undefined)
})

test('a verified update starts once without method selection and retains progress and cancellation', async context => {
  const installed = { ...adapter, installed: true, update: { state: 'available' as const, latestVersion: '2.0.0' } }
  const updatePlan = { ...plan, adapter: installed, action: 'update', automaticMethodId: 'npm' }
  const calls: { endpoint: string; payload: any }[] = []
  let operation: CliManagementOperation | null = null
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint, payload) => {
    calls.push({ endpoint, payload })
    if (endpoint.endsWith('/plan')) return { ok: true, value: updatePlan }
    if (endpoint.endsWith('/start')) operation = { id: 'automatic', adapterId: 'codex', action: 'update', state: 'running', output: '' }
    return { ok: true, value: operation }
  } }
  const view = createHookRenderer(CliManagementDialog, { adapter: installed, rpc, hostLabel: 'Local', t, onClose() {}, onCatalogChanged() {} })
  context.after(() => view.dispose())
  view.render(); const output = await flush(view)
  assert.deepEqual(calls.map(call => call.endpoint), ['cli/management/status', 'cli/management/plan', 'cli/management/start'])
  assert.deepEqual(calls.at(-1)!.payload, { adapterId: 'codex', action: 'update', methodId: 'npm', fingerprint: 'reviewed' })
  assert.equal(elements(output).some(element => element.type === 'select'), false)
  assert.equal(elements(output).find(element => element.type === 'details')!.props.open, false)
  assert.ok(button(output, t('cli.manage.cancel')))
  await flush(view)
  assert.equal(calls.filter(call => call.endpoint.endsWith('/start')).length, 1)
})

test('failed automatic starts are not repeated by status retries or when another update is running', async context => {
  for (const otherRunning of [false, true]) {
    const installed = { ...adapter, installed: true }
    let starts = 0
    const rpc: CodingNsRpcClient = { call: async (_channel, endpoint) => {
      if (endpoint.endsWith('/plan')) return { ok: true, value: { ...plan, action: 'update', automaticMethodId: 'npm' } }
      if (endpoint.endsWith('/start')) { starts++; throw new Error('Connection lost') }
      return { ok: true, value: otherRunning ? { id: 'other', adapterId: 'gemini', action: 'update', state: 'running', output: '' } : null }
    } }
    const view = createHookRenderer(CliManagementDialog, { adapter: installed, rpc, hostLabel: 'Local', t, onClose() {}, onCatalogChanged() {} })
    context.after(() => view.dispose())
    view.render(); let output = await flush(view)
    assert.equal(starts, otherRunning ? 0 : 1)
    if (!otherRunning) {
      button(output, t('cli.manage.retryStatus'))!.props.onClick()
      output = await flush(view)
      assert.equal(starts, 1)
      assert.ok(button(output, t('cli.manage.run', { action: t('cli.manage.update') })))
    }
  }
})

test('reopening a stale update entry recovers completion instead of running the same target again', async context => {
  const installed = { ...adapter, installed: true, version: '1.0.0', update: { state: 'available' as const, latestVersion: '2.0.0' } }
  const operation: CliManagementOperation = { id: 'done', adapterId: 'codex', action: 'update', state: 'succeeded', output: '', adapter: { ...installed, version: '2.0.0' } }
  let refreshed = 0
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint) => {
    assert.equal(endpoint, 'cli/management/status')
    return { ok: true, value: operation }
  } }
  const view = createHookRenderer(CliManagementDialog, { adapter: installed, rpc, hostLabel: 'Local', t, onClose() {}, onCatalogChanged() { refreshed++ } })
  context.after(() => view.dispose())
  view.render(); const output = await flush(view)
  assert.equal(refreshed, 1)
  assert.equal(elements(output).find(element => element.type === ManagementStatus)!.props.operation.adapter.version, '2.0.0')
})

test('terminal logs follow output, pause while reading older lines, and resume on demand', context => {
  const operation: CliManagementOperation = { id: 'logs', adapterId: 'codex', action: 'update', state: 'running', output: 'Checking…\n' }
  const view = createHookRenderer(CliManagementTerminal, { operation, t })
  context.after(() => view.dispose())
  let output = view.render()
  const log = elements(output).find(element => element.props.role === 'log')!
  const viewport = { scrollTop: 0, scrollHeight: 500, clientHeight: 200 }
  ;(log as any).ref.current = viewport
  output = view.render({ operation: { ...operation, output: 'Checking…\nDownloading…\n' }, t })
  assert.equal(viewport.scrollTop, 500)
  assert.equal(log.props.tabIndex, 0)
  viewport.scrollTop = 70
  log.props.onScroll({ currentTarget: viewport })
  viewport.scrollHeight = 700
  output = view.render({ operation: { ...operation, output: '<script>plain log text</script>\n' }, t })
  assert.equal(viewport.scrollTop, 70, 'new logs do not interrupt reading')
  assert.equal(elements(output).find(element => element.props.role === 'log')!.props.children, '<script>plain log text</script>\n')
  button(output, t('cli.manage.latestOutput'))!.props.onClick()
  assert.equal(viewport.scrollTop, 700)
  output = view.render()
  assert.equal(button(output, t('cli.manage.latestOutput')), undefined)
  output = view.render({ operation: { ...operation, id: 'next', output: '' }, t })
  assert.ok(text(output).includes(t('cli.manage.waitingOutput')))
})

test('operation results distinguish success, errors and cancellation with icons and readable details', () => {
  for (const state of ['running', 'succeeded', 'failed', 'cancelled'] as const) {
    const operation: CliManagementOperation = { id: state, adapterId: 'codex', action: 'update', state, output: '',
      adapter: { ...adapter, installed: true, version: '2.0.0' }, ...(state === 'failed' ? { error: 'Permission denied' } : {}) }
    const output = ManagementStatus({ operation, t })
    assert.equal(output.props.role, state === 'failed' ? 'alert' : 'status')
    assert.equal(output.props['data-state'], state)
    assert.ok(elements(output).some(element => element.type === 'svg'))
    assert.ok(text(output).includes(t(`cli.manage.result.${state}`, { action: t('cli.manage.update') })))
    if (state === 'failed') assert.ok(text(output).includes('Permission denied'))
    if (state === 'succeeded') assert.ok(text(output).includes('2.0.0'))
  }
})

test('catalog refresh failure keeps update success visible and retries only the refresh', async context => {
  const installed = { ...adapter, installed: true, update: { state: 'available' as const, latestVersion: '2.0.0' } }
  const operation: CliManagementOperation = { id: 'done-refresh', adapterId: 'codex', action: 'update', state: 'succeeded', output: 'Done', adapter: { ...installed, version: '2.0.0' } }
  const calls: string[] = []
  let refreshes = 0
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint) => { calls.push(endpoint); return { ok: true, value: operation } } }
  const view = createHookRenderer(CliManagementDialog, { adapter: installed, rpc, hostLabel: 'Local', t, onClose() {},
    async onCatalogChanged() { if (++refreshes === 1) throw new Error('Offline') },
  })
  context.after(() => view.dispose())
  view.render(); let output = await flush(view)
  assert.ok(text(output).includes(t('cli.manage.catalog.failed')))
  assert.equal(elements(output).find(element => element.type === ManagementStatus)!.props.operation.state, 'succeeded')
  button(output, t('cli.manage.refreshList'))!.props.onClick()
  output = await flush(view)
  assert.ok(text(output).includes(t('cli.manage.catalog.refreshed')))
  assert.equal(refreshes, 2)
  assert.deepEqual(calls, ['cli/management/status'])
})

test('closing progress keeps completion tracking active and refreshes the list when done', async context => {
  const installed = { ...adapter, installed: true, update: { state: 'available' as const, latestVersion: '2.0.0' } }
  let operation: CliManagementOperation = { id: 'background', adapterId: 'codex', action: 'update', state: 'running', output: 'Downloading' }
  let tracking = false
  const completed: CliManagementOperation[] = []
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint) => {
    assert.equal(endpoint, 'cli/management/status')
    return { ok: true, value: operation }
  } }
  const props: CliManagementDialogProps = { adapter: installed, rpc, hostLabel: 'Local', t, onClose(keepTracking) { tracking = keepTracking === true }, onCatalogChanged(result) { if (result) completed.push(result) } }
  const view = createHookRenderer(CliManagementDialog, props, { checkHookOrder: true })
  context.after(() => view.dispose())
  view.render(); let output = await flush(view)
  button(output, t('cli.manage.close'))!.props.onClick()
  assert.equal(tracking, true)
  output = view.render({ ...props, visible: false })
  assert.equal(elements(output).some(element => element.type === CliManagementTerminal), false)
  operation = { ...operation, state: 'succeeded', adapter: { ...installed, version: '2.0.0' } }
  await delay(800); await flush(view)
  assert.equal(completed.length, 1)
  assert.equal(completed[0]!.adapter?.version, '2.0.0')
})

test('background completion tracking recovers from a transient status error', async context => {
  let calls = 0, refreshes = 0
  const running: CliManagementOperation = { id: 'retry-poll', adapterId: 'codex', action: 'update', state: 'running', output: '' }
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint) => {
    assert.equal(endpoint, 'cli/management/status')
    if (++calls === 2) throw new Error('Temporary connection loss')
    return { ok: true, value: calls === 1 ? running : { ...running, state: 'succeeded', adapter: { ...adapter, installed: true, version: '2.0.0' } } }
  } }
  const view = createHookRenderer(CliManagementDialog, { adapter, rpc, hostLabel: 'Local', t, visible: false, onClose() {}, onCatalogChanged() { refreshes++ } })
  context.after(() => view.dispose())
  view.render(); await flush(view)
  await delay(800); await flush(view)
  assert.equal(calls, 2)
  assert.equal(refreshes, 0)
  await delay(1_550); await flush(view)
  assert.equal(calls, 3)
  assert.equal(refreshes, 1)
})

test('closing while method detection is pending never starts an automatic updater', async context => {
  const installed = { ...adapter, installed: true }
  const pending = Promise.withResolvers<unknown>()
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint) => {
    if (endpoint.endsWith('/plan')) return { ok: true, value: await pending.promise }
    assert.equal(endpoint, 'cli/management/status')
    return { ok: true, value: null }
  } }
  const view = createHookRenderer(CliManagementDialog, { adapter: installed, rpc, hostLabel: 'Local', t, onClose() {}, onCatalogChanged() {} })
  context.after(() => view.dispose())
  view.render(); await flush(view); view.dispose()
  pending.resolve({ ...plan, action: 'update', automaticMethodId: 'npm' })
  await setImmediate()
})

test('reopening a running operation resumes status and disposal ignores late results', async context => {
  const operation: CliManagementOperation = { id: 'resume', adapterId: 'codex', action: 'install', state: 'running', output: 'working' }
  const calls: string[] = []
  let changes = 0
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint) => { calls.push(endpoint); return { ok: true, value: operation } } }
  const view = createHookRenderer(CliManagementDialog, { adapter, rpc, hostLabel: 'Local', t, onClose() {}, onCatalogChanged() { changes += 1 } })
  context.after(() => view.dispose())
  view.render(); const output = await flush(view)
  assert.ok(button(output, t('cli.manage.cancel')))
  assert.deepEqual(calls, ['cli/management/status'])
  view.dispose(); await delay(800)
  assert.deepEqual(calls, ['cli/management/status'])
  assert.equal(changes, 0)
})
