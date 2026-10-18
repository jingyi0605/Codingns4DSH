import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { gitManagementFeature, registerGitManagementUi } from '../src/client/git-management.js'
import { ModelPriorityPool } from '../src/client/model-priority-pool.js'
import { SettingsToggleRow } from '../src/client/settings-controls.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { createCodingNsSettingsBridge } from '../src/client/settings-bridge.js'
import { createCodingNsRpcHandler, createCodingNsSettingsRpcHandler } from '../src/host/rpc.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { CodingNsSettingsSchema } from '../src/host/settings.js'
import { DEFAULT_GIT_MANAGEMENT_SETTINGS } from '../src/shared/contracts/git.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

function elements(node: ReactNode): ReactElement<any>[] {
  return isValidElement<{ children?: ReactNode }>(node)
    ? [node, ...Children.toArray(node.props.children).flatMap(elements)] : []
}

test('Git settings persist through Host RPC and reload without changing translation preferences', async (t) => {
  let saved = CodingNsSettingsSchema({ sessionTranslation: { translationModels: [{ provider: 'translation', model: 'separate' }] } } as never)
  const translation = structuredClone(saved.sessionTranslation)
  assert.equal(saved.gitManagement.commitMessageEnabled, true)
  let revision = 1
  let rejectWrite = false
  const table = new CodingNsRpcTable()
  table.register('settings', createCodingNsSettingsRpcHandler({
    writable: true,
    describe: () => [{ ns: '@jingyi0605/codingns4dsh', revision }],
    get: () => saved,
    async mutate(_namespace: string, operations: any[]) {
      if (rejectWrite) throw new Error('Write rejected')
      for (const operation of operations) {
        assert.deepEqual(operation.path, ['gitManagement'])
        saved = CodingNsSettingsSchema({ ...saved, gitManagement: operation.value })
      }
      revision++
    },
  } as never))
  const requests: string[] = []
  const handler = createCodingNsRpcHandler(table)
  const rpc = { async call(_channel: string, endpoint: string, payload: unknown) {
    requests.push(endpoint)
    if (endpoint === 'git/models') return { ok: true as const, value: { models: [], default: null, errors: [] } }
    return handler(endpoint, payload, new AbortController().signal)
  } }
  const settings = createCodingNsSettingsBridge(undefined, rpc)
  t.after(() => settings.dispose())
  await settings.load()
  const notices: any[] = []
  const localeSnapshot = { revision: 0 }
  const locale = { bind: () => resolveCodingNsTranslator(), subscribe: () => () => undefined, getSnapshot: () => localeSnapshot }
  const props = () => ({ services: { settings, rpc, locale }, snapshot: settings.getSnapshot(), enabled: true, notify: (notice: any) => notices.push(notice) })
  const view = createHookRenderer(gitManagementFeature.settingsPanel!, props() as never)
  t.after(() => view.dispose())
  const fields = () => elements(view.render(props() as never))
  assert.equal(fields().find((field) => field.type === SettingsToggleRow)!.props.checked, true)
  await setImmediate()
  assert.ok(requests.includes('git/models'))
  assert.equal(requests.some((endpoint) => endpoint.includes('translation')), false)
  fields().find((field) => field.type === 'select')!.props.onChange({ currentTarget: { value: 'detailed' } })
  await setImmediate()
  const models = [{ provider: 'native', model: 'second' }, { provider: 'native', model: 'first' }]
  assert.equal(await fields().find((field) => field.type === ModelPriorityPool)!.props.onChange(models), true)
  assert.deepEqual(saved.gitManagement, { ...DEFAULT_GIT_MANAGEMENT_SETTINGS, commitMessageDetail: 'detailed', commitMessageModels: models })
  fields().find((field) => field.type === SettingsToggleRow)!.props.onChange(false)
  await setImmediate()
  assert.equal(fields().find((field) => field.type === 'select')!.props.disabled, true)
  assert.equal(fields().find((field) => field.type === ModelPriorityPool)!.props.disabled, true)
  assert.deepEqual(saved.sessionTranslation, translation)
  assert.equal(saved.gitManagement.commitMessageEnabled, false)
  const reloaded = createCodingNsSettingsBridge(undefined, rpc)
  t.after(() => reloaded.dispose())
  await reloaded.load()
  assert.deepEqual(reloaded.getSnapshot().value?.gitManagement, saved.gitManagement)
  const before = structuredClone(saved.gitManagement)
  rejectWrite = true
  fields().find((field) => field.type === SettingsToggleRow)!.props.onChange(true)
  await setImmediate()
  assert.deepEqual(saved.gitManagement, before)
  assert.equal(notices.at(-1).kind, 'error')
  assert.equal(fields().find((field) => field.type === SettingsToggleRow)!.props.checked, false)
  const readOnly = elements(view.render({ ...props(), snapshot: { ...settings.getSnapshot(), writable: false } } as never))
  assert.equal(readOnly.find((field) => field.type === SettingsToggleRow)!.props.disabled, true)
})

test('Git panel generates editable multiline drafts, preserves drafts on failure, and cancels stale replies', async (t) => {
  const registered = new Map<string, { component: (props: any) => ReactElement; props: any }>()
  const workspaceSnapshot = { items: [{ workspaceId: 'generation-workspace', sessionIds: ['generation-session'] }] }
  const context = {
    get: () => ({ list: { getSnapshot: () => workspaceSnapshot, subscribe: () => () => undefined } }),
    sidebarRight: {}, sidebarRightTabs: { register: () => () => undefined },
    slots: {
      inject: (_name: string, install: () => () => void) => install(),
      register(options: any, component: (props: any) => ReactElement) {
        registered.set(options.name, { component, props: options.inject() })
        return () => undefined
      },
    },
  }
  let snapshot = { value: { gitManagement: DEFAULT_GIT_MANAGEMENT_SETTINGS } }
  const settings = { subscribe: () => () => undefined, getSnapshot: () => snapshot }
  const calls: string[] = []
  let resolveDraft!: (value: unknown) => void
  let fail = false
  let staged = true
  let requestSignal: AbortSignal | undefined
  const rpc = { async call(_channel: string, endpoint: string, _payload: unknown, signal?: AbortSignal) {
    calls.push(endpoint)
    if (endpoint === 'git/generate-message') {
      if (fail) throw new Error('Generation failed')
      requestSignal = signal
      return new Promise((resolve) => { resolveDraft = resolve })
    }
    const values = {
      'git/status': { snapshot: { enabled: true }, changes: staged ? [{ path: 'staged.ts', staged: true, stagedStatus: 'M' }] : [] },
      'git/history': { items: [], totalCount: 0 },
      'git/branches': { currentBranch: 'main', local: [], remote: [] },
    }
    assert.ok(endpoint in values)
    return { ok: true, value: values[endpoint as keyof typeof values] }
  } }
  t.after(registerGitManagementUi(context as never, { rpc: rpc as never, settings: settings as never }))
  const panel = registered.get('sidebar.right.pane.tab')!
  const view = createHookRenderer(panel.component, { ...panel.props, sessionId: 'generation-session', useTabInfo: () => ({ tab: { signal: new AbortController().signal } }) })
  t.after(() => view.dispose())
  const tGit = resolveCodingNsTranslator()
  const fields = () => elements(view.render())
  const button = () => fields().find((field) => field.props['aria-label'] === tGit('git.draftMessage'))
  const editor = () => fields().find((field) => field.type === 'textarea')!
  view.render()
  await setImmediate()
  editor().props.onChange({ currentTarget: { value: 'Existing draft' } })
  assert.equal(button()!.props.disabled, false)
  button()!.props.onClick()
  assert.equal(button()!.props['aria-busy'], true)
  const message = 'Update Git controls\n\n- Add model priority settings'
  resolveDraft({ ok: true, value: { message } })
  await setImmediate()
  assert.equal(editor().props.value, message)
  assert.equal(editor().props.rows, 3)
  assert.equal(editor().props.onKeyDown, undefined, 'Enter must allow multiline messages')
  assert.equal(calls.filter((endpoint) => endpoint === 'git/generate-message').length, 1)
  assert.equal(calls.some((endpoint) => ['git/commit', 'git/stage'].includes(endpoint)), false)
  fail = true
  button()!.props.onClick()
  await setImmediate()
  assert.equal(editor().props.value, message)
  assert.ok(fields().some((field) => field.props.role === 'alert'))
  fail = false
  button()!.props.onClick()
  snapshot = { value: { gitManagement: { ...DEFAULT_GIT_MANAGEMENT_SETTINGS, commitMessageEnabled: false } } }
  assert.equal(button(), undefined)
  assert.equal(requestSignal?.aborted, true)
  resolveDraft({ ok: true, value: { message: 'Stale result' } })
  await setImmediate()
  assert.equal(editor().props.value, message)
  snapshot = { value: { gitManagement: DEFAULT_GIT_MANAGEMENT_SETTINGS } }
  staged = false
  fields().find((field) => field.type === 'button' && field.props.children === tGit('git.refresh'))!.props.onClick()
  await setImmediate()
  assert.equal(button()!.props.disabled, true)
})
