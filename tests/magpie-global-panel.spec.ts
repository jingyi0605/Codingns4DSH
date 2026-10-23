import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DSH_VERSION } from '../src/shared/contracts/version.js'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { createGlobalPanelAdapter } from '../src/dsh-capabilities/client/global-panel-adapter.js'
import type { CodingNsLocale } from '../src/client/locale.js'
import { MagpieManagementPage } from '../src/client/features/magpie-management-page.js'
import { magpieManagementFeature } from '../src/client/features/magpie-management.js'
import { GroupModelPicker, MagpieGroupsPage, MagpieProvidersPage, reorderModels } from '../src/client/features/magpie-management-controls.js'
import { installProviderIcons, PROVIDER_ICONS } from '../src/client/provider-icons.js'
import type { MagpieManagementSnapshot } from '../src/shared/contracts/magpie-management.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'

type SlotName = 'sidebar.panellist' | 'main'
type SlotEffect = () => () => void

class TestSlots {
  readonly entries: { readonly options: Record<string, unknown>; readonly component: unknown }[] = []
  private readonly declared = new Set<SlotName>()
  private readonly injectors = new Map<SlotName, Set<SlotEffect>>()

  inject(name: SlotName, callback: SlotEffect): () => void {
    const listeners = this.injectors.get(name) ?? new Set<SlotEffect>()
    this.injectors.set(name, listeners)
    listeners.add(callback)
    let disposeEffect: (() => void) | undefined
    const activate = (): void => {
      if (disposeEffect !== undefined) return
      disposeEffect = callback()
    }
    if (this.declared.has(name)) activate()
    return () => {
      listeners.delete(callback)
      disposeEffect?.()
      disposeEffect = undefined
    }
  }

  register(options: Record<string, unknown>, component: unknown): () => void {
    const entry = { options, component }
    this.entries.push(entry)
    return () => {
      const index = this.entries.indexOf(entry)
      if (index >= 0) this.entries.splice(index, 1)
    }
  }

  declare(name: SlotName): void {
    this.declared.add(name)
    for (const callback of this.injectors.get(name) ?? []) callback()
  }
}

test('Magpie registers a native sidebar row only after both DSH panel seats exist and cleans up with the feature', () => {
  const slots = new TestSlots()
  const selected: (string | null)[] = []
  const services = { rpc: { call: async () => ({ ok: true as const, value: null }) } }
  const icon = (() => null) as never
  const page = (() => null) as never
  const adapter = createGlobalPanelAdapter({ slots, layout: { selectPanel: (id: string | null) => selected.push(id) } })
  const dispose = adapter.register({
    id: 'codingns4dsh-magpie-management',
    order: 1,
    label: () => 'Magpie Management',
    icon,
    page,
    pageProps: { services },
  })

  slots.declare('main')
  assert.deepEqual(slots.entries, [], 'do not publish a row until its main page is registerable')
  slots.declare('sidebar.panellist')
  assert.deepEqual(slots.entries.map(({ options }) => options.name), ['main', 'sidebar.panellist'])

  const main = slots.entries[0]!
  assert.equal(main.options.key, 'codingns4dsh-magpie-management')
  assert.equal(main.component, page)
  const props = (main.options.inject as () => { services: unknown; onClose: () => void })()
  assert.equal(props.services, services)
  props.onClose()
  assert.deepEqual(selected, [null], 'the page back action returns to the current conversation via DSH layout')

  const sidebar = slots.entries[1]!
  assert.equal(sidebar.options.id, 'codingns4dsh-magpie-management')
  assert.equal(sidebar.options.order, 1, 'Plugins uses order 0; Magpie follows it immediately')
  assert.equal((sidebar.options.label as () => string)(), 'Magpie Management')
  assert.equal(sidebar.component, icon)

  dispose()
  assert.deepEqual(slots.entries, [], 'the native row and page are removed when the opt-in feature is disabled')
})

test('Magpie sidebar row reads Magpie and renders the background-free mark in the current color', () => {
  const slots = new TestSlots()
  const translator = resolveCodingNsTranslator()
  const locale = {
    bind: () => translator,
    getSnapshot: () => ({ revision: 0 }),
    subscribe: () => () => undefined,
    register: () => () => undefined,
  }
  const resources: (() => void)[] = []
  magpieManagementFeature.start({
    services: {
      rpc: { call: async () => ({ ok: true as const, value: null }) },
      locale,
      uiContext: { slots, layout: { selectPanel: () => undefined } },
    },
    resources: { add: (dispose: () => void) => { resources.push(dispose) } },
  } as never)
  slots.declare('main')
  slots.declare('sidebar.panellist')

  const sidebar = slots.entries.find((entry) => entry.options.name === 'sidebar.panellist')
  assert.ok(sidebar !== undefined, 'the sidebar row is registered once both DSH panel seats exist')
  assert.equal((sidebar.options.label as () => string)(), 'Magpie', 'the row reads Magpie instead of Magpie Management')

  const markup = renderToStaticMarkup(createElement(sidebar.component as never, { size: 16, active: false }))
  assert.match(markup, /<svg[^>]*viewBox="0 0 100 100"/u, 'the row draws the vector magpie mark')
  assert.match(markup, /fill="currentColor"/u, 'the mark inherits the sidebar text colour like the native icons')
  assert.match(markup, /<path fill-rule="evenodd" d="M2\.36/u, 'the mark is the background-free magpie silhouette')
  assert.doesNotMatch(markup, /<img|mask-image/u, 'the row depends on no external icon asset or CSS mask')
  for (const dispose of resources) dispose()
})

test('global panel capability is gated by the supported DSH range and the required services', () => {
  const context = { slots: { inject() {}, register() {} }, layout: { selectPanel() {} } }
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2']) {
    const capability = createDshCapabilityRegistry(version, 'client', context).getProfile(context).capabilities.get('sidebar.global-panel')
    assert.equal(capability?.status, 'unavailable', version)
  }
  assert.equal(createDshCapabilityRegistry(DSH_VERSION, 'client', context).getProfile(context).capabilities.get('sidebar.global-panel')?.status, 'ready')
  assert.equal(createDshCapabilityRegistry(DSH_VERSION, 'client', { slots: context.slots }).getProfile({ slots: context.slots }).capabilities.get('sidebar.global-panel')?.status, 'unavailable')
})

test('Magpie dashboard renders as a flat page region rather than a modal overlay', () => {
  const translator = resolveCodingNsTranslator()
  const locale = {
    bind: () => translator,
    getSnapshot: () => ({ revision: 0 }),
    subscribe: () => () => undefined,
    register: () => () => undefined,
  } as unknown as CodingNsLocale
  const markup = renderToStaticMarkup(createElement(MagpieManagementPage, {
    rpc: { call: async () => ({ ok: true as const, value: null }) },
    locale,
    onClose: () => undefined,
  }))

  assert.match(markup, /role="region"/u)
  assert.doesNotMatch(markup, /role="dialog"|aria-modal|position:fixed/u)
  assert.match(markup, /width:100%;height:100%;min-width:0;min-height:0/u)
  assert.match(markup, /--dsh-frame-top-clearance/u)
  const rootStyle = /class="codingns-magpie-page"[^>]*style="([^"]*)"/u.exec(markup)?.[1] ?? ''
  assert.ok(rootStyle.includes('padding-top:var(--dsh-frame-top-clearance, 0px)'), 'entry pages still clear the window top strip')
  assert.ok(!rootStyle.includes('padding-left'), 'the page surface is no longer indented by the frame leading clearance')
  assert.doesNotMatch(markup, /aria-label="返回当前对话"|codingns-magpie-close/u, 'the page no longer renders its own back button; DSH owns that affordance')
  assert.doesNotMatch(markup, /codingns-magpie-brand|codingns-magpie-mark/u, 'the page no longer renders its own brand block')
  assert.match(markup, /codingns-magpie-periods\{flex-direction:row;overflow:auto/u, 'period controls remain usable on narrow screens')
  assert.match(markup, /html\[data-codingns-mobile-sidebar=&quot;on&quot;\] \.codingns-magpie-page\{padding-left:0/u, 'a hidden mobile sidebar keeps the page full width instead of indenting it by the frame leading clearance')
  assert.match(markup, /\.codingns-magpie-topbar\{[^}]*var\(--mp-leading-inset\)/u, 'only the header row clears the floating logo button')
  assert.match(markup, /\.codingns-magpie-toolbar:not\(\.has-tabs\)\{display:none\}/u, 'the empty toolbar row is dropped on phones')
  assert.match(markup, /\.codingns-magpie-statstrip\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/u, 'phone statistic cells collapse to two columns')
  assert.match(markup, /codingns-magpie-tabs/u, 'sections are reachable from a top tab bar')
  assert.match(markup, /codingns-magpie-tab is-active" aria-current="page">/, 'the current section is marked on the tab bar')
  assert.doesNotMatch(markup, /codingns-magpie-rail|codingns-magpie-nav-item/u, 'the page no longer draws its own left sidebar next to the DSH sidebar')
  assert.match(markup, />总览</u, 'Overview is a top-level native tab')
  assert.match(markup, />提供商</u)
  assert.match(markup, />路由</u, 'Routing is a top-level native tab')
  assert.match(markup, />用量</u, 'Usage is a top-level tab')
  assert.doesNotMatch(markup, /nav-item[^>]*>[^<]*账户/u, 'accounts are not a standalone management section')
})

test('Magpie usage tabs follow the native order and render native report chrome', () => {
  const translator = resolveCodingNsTranslator()
  const locale = {
    bind: () => translator,
    getSnapshot: () => ({ revision: 0 }),
    subscribe: () => () => undefined,
    register: () => () => undefined,
  } as unknown as CodingNsLocale
  const markup = renderToStaticMarkup(createElement(MagpieManagementPage, {
    rpc: { call: async () => ({ ok: true as const, value: null }) },
    locale,
    onClose: () => undefined,
    initialPageTab: 'usage',
  }))

  const usageTabs = markup.slice(markup.lastIndexOf('codingns-magpie-usage-tabs'), markup.lastIndexOf('codingns-magpie-toolbar-right'))
  const order = ['订阅', '会话', '请求'].map((label) => usageTabs.indexOf(`>${label}<`))
  assert.ok(order.every((index) => index >= 0), 'Usage exposes Subscriptions, Sessions, and Requests')
  assert.deepEqual([...order].sort((left, right) => left - right), order, 'Usage tabs keep the native Magpie order')
  assert.match(markup, /codingns-magpie-statstrip/u, 'native report statistic strip is used')
  assert.match(markup, /class="codingns-magpie-toolbar has-tabs"/u, 'the usage toolbar keeps its sub-tabs on phones')
  assert.match(markup, /codingns-magpie-barchart/u, 'native bar chart is used instead of the old line chart')
  assert.match(markup, /codingns-magpie-progress-track/u, 'breakdowns use native progress rows')
  assert.match(markup, /codingns-magpie-group-model-picker-search/u, 'routing-group picker styles are included in the flat page')
})

test('Magpie management nests primary and secondary accounts under providers', () => {
  const translator = resolveCodingNsTranslator()
  const t = (key: string, params?: Record<string, string | number>) => translator(key, params)
  const snapshot: MagpieManagementSnapshot = {
    capturedAt: '2026-10-22T00:00:00Z',
    availabilityIssue: null,
    providerStatus: 'available',
    providers: [{
      id: 'openai-subscription', name: 'Codex Subscription', accountAgent: 'codex', preset: null, protocol: 'chat', host: 'api.example.com', website: null,
      state: 'on', account: 'test-account', keyMasked: null,
      endpoints: [{ field: 'chat', url: 'https://api.example.com/v1', editable: true }],
      models: [
        { id: 'openai-subscription/model', name: 'Demo Model', exposed: true },
        { id: 'openai-subscription/backup', name: 'Backup Model', exposed: false },
      ], modelsEditable: true,
      modelCount: 2, exposedModelCount: 1, fallback: [], routing: null, affinity: null, maxConcurrency: null,
    }],
    accountStatus: 'available',
    accounts: [{
      agent: 'codex', user: 'codex-user', alias: null, plan: 'Plus', active: true, on: false,
      balance: null, windows: [], asOf: null, readAt: null,
    }, {
      agent: 'codex', user: 'backup-user', alias: null, plan: 'Plus', active: false, on: true,
      balance: null, windows: [], asOf: null, readAt: null,
    }],
    accountApiStatus: 'available',
    groupStatus: 'available',
    groups: [{
      id: 'fast', name: 'Fast pool', routing: 'order', stays: 'session',
      members: [{ id: 'openai-subscription/model', provider: 'openai-subscription', name: 'Demo Model', model: 'model', on: true, ready: true, byPattern: false }],
      usedBy: ['Codex'], patterns: [],
    }],
  }
  const props = {
    snapshot,
    t,
    onUpdate: async () => undefined,
    onAccountUpdate: async () => undefined,
    writing: false,
  }
  const previousIcons = { ...PROVIDER_ICONS }
  installProviderIcons({ codex: 'asset:codex' })
  let providers = ''
  let groups = ''
  try {
    providers = renderToStaticMarkup(createElement(MagpieProvidersPage, props))
    groups = renderToStaticMarkup(createElement(MagpieGroupsPage, props))
  } finally {
    installProviderIcons(previousIcons)
  }
  assert.match(providers, /src="asset:codex"/u, 'provider and account cards render the cached logo URL')
  assert.match(groups, /src="asset:codex"/u, 'routing model rows render their provider account logo')
  assert.match(providers, /Codex Subscription/u)
  assert.match(providers, /api\.example\.com/u)
  assert.match(providers, /停用提供商/u)
  assert.match(providers, /主账户/u)
  assert.match(providers, /codex-user/u)
  assert.match(providers, /次级账户/u)
  assert.match(providers, /backup-user/u)
  assert.ok(providers.indexOf('codex-user') < providers.indexOf('backup-user'), 'the signed-in primary appears before secondary accounts')
  assert.doesNotMatch(providers, /未匹配到提供商的账户/u, 'accounts link through accountAgent even when it differs from provider.id')
  assert.match(providers, /Host 已自动启动并认证 Magpie Web/u)
  assert.match(providers, /加入故障转移轮换/u)
  assert.doesNotMatch(providers, /test-secret|api_key=/u)
  assert.match(groups, /Fast pool/u)
  assert.match(groups, /name="|option value="rotate"/u)
  assert.match(groups, /openai-subscription\/model/u)
  assert.match(groups, /class="codingns-magpie-model-name"[^>]*>Demo Model</u, 'routing-group model names remain visible')
  assert.match(groups, /class="codingns-magpie-model-id"[^>]*>openai-subscription\/model</u, 'routing-group model IDs remain visible as secondary metadata')
  assert.doesNotMatch(groups, /codingns-magpie-group-model-available/u, 'routing groups do not render the full available-model inventory')
  assert.match(groups, /aria-label="添加模型"/u, 'routing groups retain a compact add-model control')
  assert.match(groups, /aria-controls="codingns-magpie-group-model-picker"/u, 'routing groups expose the grouped picker from the compact add control')
  assert.match(providers, /openai-subscription\/backup/u, 'provider editor renders disabled models as available choices')
  assert.match(providers, /class="codingns-magpie-model-name"[^>]*>Backup Model</u, 'provider model names remain visible')
  assert.match(providers, /type="checkbox"/u)

  const partialSnapshot: MagpieManagementSnapshot = {
    ...snapshot,
    providerStatus: 'partial',
    providers: snapshot.providers.map(provider => ({ ...provider, modelsEditable: false })),
  }
  const partialMarkup = renderToStaticMarkup(createElement(MagpieProvidersPage, { ...props, snapshot: partialSnapshot }))
  assert.match(partialMarkup, /部分 Magpie 提供商记录无法完整解析/u)
  assert.match(partialMarkup, /<input type="checkbox" disabled=""/u, 'incomplete model rows remain read-only instead of being overwritten')

  const picker = renderToStaticMarkup(createElement(GroupModelPicker, {
    candidates: [
      { id: 'openai-subscription/backup', name: 'Backup Model', provider: 'openai-subscription', providerName: 'Codex Subscription', kind: 'model' },
      { id: 'anthropic/claude', name: 'Claude', provider: 'anthropic', providerName: 'Anthropic', kind: 'model' },
    ],
    value: ['openai-subscription/model'],
    query: '',
    t,
    onQueryChange: () => undefined,
    onSelect: () => undefined,
  }))
  assert.match(picker, /class="codingns-magpie-group-model-picker"/u)
  assert.match(picker, /placeholder="筛选模型…"/u)
  assert.match(picker, /class="codingns-magpie-group-model-picker-heading">Codex Subscription</u)
  assert.match(picker, /class="codingns-magpie-group-model-picker-heading">Anthropic</u)
  assert.match(picker, /Backup Model/u)
  assert.match(picker, /openai-subscription\/backup/u)

  const filteredPicker = renderToStaticMarkup(createElement(GroupModelPicker, {
    candidates: [
      { id: 'openai-subscription/backup', name: 'Backup Model', provider: 'openai-subscription', providerName: 'Codex Subscription', kind: 'model' },
      { id: 'anthropic/claude', name: 'Claude', provider: 'anthropic', providerName: 'Anthropic', kind: 'model' },
    ],
    value: [],
    query: 'claude',
    t,
    onQueryChange: () => undefined,
    onSelect: () => undefined,
  }))
  assert.match(filteredPicker, /Claude/u)
  assert.doesNotMatch(filteredPicker, /Backup Model/u)
})

test('routing-group model order helper moves selected entries without changing membership', () => {
  assert.deepEqual(reorderModels(['a', 'b', 'c'], 'a', 'c'), ['b', 'a', 'c'])
  assert.deepEqual(reorderModels(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b'])
  assert.deepEqual(reorderModels(['a', 'b'], 'missing', 'b'), ['a', 'b'])
})
