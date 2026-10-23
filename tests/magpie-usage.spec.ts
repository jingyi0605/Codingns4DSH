import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { MagpieUsageService, magpieAgentForAdapter, parseMagpieCliVersion, parseMagpieModelMetadata, parseMagpieModelOutput, parseMagpieQuotas } from '../src/host/cli-adapters/magpie-usage.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { SUBSCRIPTION_RESPONSIVE_CSS, calculateMagpiePopoverPlacement, registerSubscriptionSlot } from '../src/client/subscription-slot.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const usageReply = (sessions: unknown[] = [{
  agent: 'claude', id: 'agent-session-1', input: 120, output: 30,
  cache_read: 12, cache_write: 4, cost: 0.0125,
}]) => ({
  calls: 3, errors: 1, input: 300, output: 90, cache_read: 20, cache_write: 8, cost: 0.0325,
  sessions,
})

function fakeMagpieWebApi(fetcher: typeof fetch) {
  return {
    async requestJson(path: string, options: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<unknown> {
      const response = await fetcher(new URL(path, 'http://127.0.0.1:3430'), {
        method: options.method ?? 'GET',
        signal: options.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new Error(`mock Magpie Web API returned HTTP ${response.status}`)
      }
      return response.json() as Promise<unknown>
    },
  }
}

function createWebUsageService(options: ConstructorParameters<typeof MagpieUsageService>[0] = {}): MagpieUsageService {
  const fetcher = options.fetch ?? (async () => Response.json({})) as typeof fetch
  return new MagpieUsageService({ ...options, webApi: options.webApi ?? fakeMagpieWebApi(fetcher) })
}

test('Magpie usage popover stays within viewport and shifts left of an open right sidebar', () => {
  assert.deepEqual(calculateMagpiePopoverPlacement(800, 1200, null), { left: -12, width: 400 })
  assert.deepEqual(calculateMagpiePopoverPlacement(800, 1200, 900), { left: -312, width: 400 })
  assert.deepEqual(calculateMagpiePopoverPlacement(500, 1200, 300), { left: -488, width: 276 })
  assert.deepEqual(calculateMagpiePopoverPlacement(16, 1280, null), { left: 0, width: 400 })
})

test('移动端用量弹层高度不超过浏览器可视高度的 75%，超出部分内部滚动', () => {
  const mobileRule = SUBSCRIPTION_RESPONSIVE_CSS.match(/@media \(max-width: 768px\)\{.*?\}\}/u)?.[0]
  assert.ok(mobileRule, '必须保留移动端媒体查询')
  const popoverRule = mobileRule.match(/\.codingns4dsh-subscription-popover\{[^}]*\}/u)?.[0]
  assert.ok(popoverRule, '移动端弹层必须由注入样式约束')
  // 75vh 兜底、75dvh 覆盖：后者按移动端真实可视区计算，二者都不得写成整屏。
  assert.match(popoverRule, /max-height:75vh!important/u)
  assert.match(popoverRule, /max-height:75dvh!important/u)
  assert.doesNotMatch(popoverRule, /max-height:(?:100vh|100dvh|calc\(100vh - 72px\))/u)
  assert.match(popoverRule, /overflow-y:auto!important/u)
  assert.match(popoverRule, /overflow-x:hidden!important/u)
  // 弹层仍是底部浮层，不能因为限制高度而脱离视口。
  assert.match(popoverRule, /position:fixed!important/u)
  assert.match(popoverRule, /bottom:48px!important/u)
})

test('Magpie 0.1.1295 目录输出按准确 Agent ID 和模型 ID 解析', async () => {
  for (const [agent, name] of [['claude', 'magpie-models-claude.txt'], ['codex', 'magpie-models-codex.txt']] as const) {
    const output = await fixture(name)
    const catalog = parseMagpieModelOutput(output, agent)
    assert.ok(catalog, `${agent} output should match the captured CLI format`)
    assert.deepEqual([...catalog.models], ['example-provider/model-one', 'example-provider/model-two'])
    assert.deepEqual([...catalog.names], [['model one', 'example-provider/model-one'], ['model two', 'example-provider/model-two']])
    assert.equal(catalog.gatewayOrigin, 'http://127.0.0.1:3425')
  }
  assert.equal(parseMagpieModelOutput('new unrecognized output\nexample-provider/model-one\n', 'claude'), null)
  assert.equal(parseMagpieModelOutput('example-provider/model-one  Model One\nhttp://127.0.0.1:3425/v1\n', 'claude'), null)
  assert.equal(parseMagpieModelOutput('example-provider/model-one  Model One\nhttp://127.0.0.1:3425/v1\nhttp://127.0.0.1:3426/v1\n', 'claude'), null)
  assert.equal(parseMagpieModelOutput('example-provider/model-one  Model One\nclaudex is shown every provider\'s models\nhttp://127.0.0.1:3425/v1\n', 'claude'), null)
  assert.equal(parseMagpieModelOutput('example-provider/model-one  Model One\n', '../claude'), null)
})

test('Magpie catalog keeps only unique normalized display-name aliases', () => {
  const catalog = parseMagpieModelOutput([
    'Example provider',
    'provider/one    Shared Label',
    'provider/two    shared label',
    'provider/three    Unique Label',
    'provider/four    \u001b[31mUnsafe Label',
    "claude is shown every provider's models · magpie visible claude",
    'http://127.0.0.1:3425/v1',
  ].join('\n'), 'claude')
  assert.ok(catalog)
  assert.equal(catalog.names.has('shared label'), false, 'ambiguous labels must not select a provider')
  assert.equal(catalog.names.get('unique label'), 'provider/three')
  assert.equal(catalog.displayNames.get('provider/three'), 'Unique Label')
  assert.equal(catalog.displayNames.has('provider/four'), false, 'control characters must not reach the model picker')
})

test('Magpie catalog retains valid model IDs when the CLI omits their display name', () => {
  const catalog = parseMagpieModelOutput([
    'Routing groups',
    'sub2api/deepseek-v4.1-flash',
    "claude is shown every provider's models · magpie visible claude",
    'http://127.0.0.1:3425/v1',
  ].join('\n'), 'claude')
  assert.ok(catalog)
  assert.equal(catalog.models.has('sub2api/deepseek-v4.1-flash'), true)
  assert.equal(catalog.names.size, 0, 'an absent display label must not create a name alias')
})

test('supported adapter IDs map to exact Magpie Web usage Agent identities', async () => {
  const adapters = [
    ['dsh', 'dsh'],
    ['claude-code', 'claude'],
    ['codex', 'codex'],
    ['command-code', 'commandcode'],
    ['kimi', 'kimi'],
    ['gemini', 'gemini'],
    ['pi', 'pi'],
    ['opencode', 'opencode'],
    ['grok', 'grok'],
    ['mcode', 'minimax-code'],
    ['zcode', 'zcode'],
    ['codebuddy', 'codebuddy'],
    ['workbuddy', 'workbuddy'],
    ['cursor-cli', 'cursor'],
    ['qoder', 'qoder'],
    ['qoder-cn', 'qoder-cn'],
    ['antigravity', 'agy'],
  ] as const

  for (const [adapterId, expectedAgent] of adapters) {
    assert.equal(magpieAgentForAdapter(adapterId), expectedAgent, adapterId)
    const service = createWebUsageService({
      readModels: async () => { throw new Error('compact usage must not call Magpie CLI') },
      readVersion: async () => { throw new Error('compact usage must not check Magpie CLI version') },
      fetch: (async () => Response.json(usageReply([{
        agent: expectedAgent, id: 'provider-session', input: 4, output: 2, cost: 0.001,
      }]))) as typeof fetch,
    })
    const result = await service.read({ adapterId, modelId: 'example-provider/model-one', providerSessionId: 'provider-session' })
    assert.equal(result?.agent, expectedAgent, adapterId)
    assert.equal(result?.session?.agent, expectedAgent, adapterId)
  }

  assert.equal(magpieAgentForAdapter('third-party-agent'), null)
  assert.equal(magpieAgentForAdapter('kiro-cli'), null)
  assert.equal(magpieAgentForAdapter('doubao'), null)
  assert.equal(magpieAgentForAdapter('Not An Agent'), null)
  assert.equal(magpieAgentForAdapter('agent/id'), null)
})

test('Magpie CLI 版本检查只接受已验证的精确版本输出', () => {
  assert.equal(parseMagpieCliVersion('magpie 0.1.1295\n'), true)
  assert.equal(parseMagpieCliVersion('magpie 0.1.1294\n'), false)
  assert.equal(parseMagpieCliVersion('magpie 0.1.1296\n'), true)
  assert.equal(parseMagpieCliVersion('magpie 0.1.1295-beta\n'), false)
  assert.equal(parseMagpieCliVersion('version 0.1.1295\n'), false)
})

test('模型目录查询并行启动适配器目录、Magpie 版本和 Magpie 模型命令', async () => {
  const modelOutput = await fixture('magpie-models-claude.txt')
  let releaseAdapterCatalog!: (catalog: { groups: []; currentModel: null; currentEffort: null }) => void
  let releaseVersion!: (version: string) => void
  let adapterStarted = false
  let versionStarted = false
  let modelsStarted = false
  const adapterCatalog = new Promise<{ groups: []; currentModel: null; currentEffort: null }>((resolve) => { releaseAdapterCatalog = resolve })
  const version = new Promise<string>((resolve) => { releaseVersion = resolve })
  const service = new MagpieUsageService({
    readVersion: async () => { versionStarted = true; return version },
    readModels: async () => { modelsStarted = true; return modelOutput },
  })

  const result = service.enrichModelCatalog('claude-code', (async () => {
    adapterStarted = true
    return adapterCatalog
  })())
  await setImmediate()
  assert.equal(adapterStarted, true)
  assert.equal(versionStarted, true)
  assert.equal(modelsStarted, true)

  releaseAdapterCatalog({ groups: [], currentModel: null, currentEffort: null })
  releaseVersion('magpie 0.1.1295')
  assert.deepEqual(await result, { groups: [], currentModel: null, currentEffort: null })
})

test('Magpie 目录和元数据的失败结果只短暂缓存', async () => {
  let now = 1
  let catalogCalls = 0
  const catalogService = new MagpieUsageService({
    now: () => now,
    readVersion: async () => 'magpie 0.1.1295',
    readModels: async () => { catalogCalls++; return null },
  })
  const ordinaryCatalog = { groups: [], currentModel: null, currentEffort: null }
  await catalogService.enrichModelCatalog('claude-code', ordinaryCatalog)
  await catalogService.enrichModelCatalog('claude-code', ordinaryCatalog)
  assert.equal(catalogCalls, 1, 'repeat failures within the short cache window should not rerun Magpie')
  now += 5_001
  await catalogService.enrichModelCatalog('claude-code', ordinaryCatalog)
  assert.equal(catalogCalls, 2, 'failed catalog reads should become retryable')

  now = 1
  let metadataCalls = 0
  const modelOutput = await fixture('magpie-models-claude.txt')
  const metadataService = new MagpieUsageService({
    now: () => now,
    readVersion: async () => 'magpie 0.1.1295',
    readModels: async () => modelOutput,
    fetch: (async () => { metadataCalls++; return Response.json({ data: [] }) }) as typeof fetch,
  })
  const matchingCatalog = {
    groups: [{ id: 'claude', name: 'Claude', models: [{ id: 'example-provider/model-one', name: 'Model One', efforts: [] }] }],
    currentModel: null,
    currentEffort: null,
  }
  await metadataService.enrichModelCatalog('claude-code', matchingCatalog)
  await metadataService.enrichModelCatalog('claude-code', matchingCatalog)
  assert.equal(metadataCalls, 1, 'unavailable metadata should not retry on every model-list request')
  now += 5_001
  await metadataService.enrichModelCatalog('claude-code', matchingCatalog)
  assert.equal(metadataCalls, 2, 'failed metadata reads should become retryable')
})

test('不同 Agent 分别确认 Magpie 目录，但共用同一组 Gateway 模型元数据缓存', async () => {
  let now = 1
  const agents: string[] = []
  let metadataCalls = 0
  const service = new MagpieUsageService({
    now: () => now,
    readVersion: async () => 'magpie 0.1.1295',
    readModels: async (agent) => {
      agents.push(agent)
      return [
        'Routing groups',
        'provider/shared-model    Shared Model',
        `${agent} is shown every provider's models · magpie visible ${agent}`,
        'http://127.0.0.1:3425/v1',
      ].join('\n')
    },
    fetch: (async (url) => {
      assert.equal(String(url), 'http://127.0.0.1:3425/v1/models')
      metadataCalls += 1
      return Response.json({ data: [{ id: 'provider/shared-model', display_name: 'Shared Model', context_window: 500000 }] })
    }) as typeof fetch,
  })
  const claudeCatalog = {
    groups: [{ id: 'claude', name: 'Claude', models: [{ id: 'provider/shared-model', name: 'Shared Model', efforts: [] }] }],
    currentModel: null, currentEffort: null,
  }
  const codexCatalog = {
    groups: [{ id: 'codex', name: 'Codex', models: [{ id: 'provider/shared-model', name: 'Shared Model', efforts: [] }] }],
    currentModel: null, currentEffort: null,
  }

  const claude = await service.enrichModelCatalog('claude-code', claudeCatalog)
  const codex = await service.enrichModelCatalog('codex', codexCatalog)
  assert.deepEqual(agents, ['claude', 'codex'], 'a successful Agent-specific CLI footer must not verify another Agent')
  assert.equal(metadataCalls, 1, 'the identical Gateway catalog is fetched only once')
  assert.equal(claude.groups[0]!.models[0]!.source, 'magpie')
  assert.equal(codex.groups[0]!.models[0]!.contextWindow, 500000)

  await service.enrichModelCatalog('claude-code', claudeCatalog)
  await service.enrichModelCatalog('codex', codexCatalog)
  assert.deepEqual(agents, ['claude', 'codex'], 'successful Agent catalogs are cached for the TTL')
  assert.equal(metadataCalls, 1)

  now += 60_001
  await service.enrichModelCatalog('claude-code', claudeCatalog)
  await service.enrichModelCatalog('codex', codexCatalog)
  assert.deepEqual(agents, ['claude', 'codex', 'claude', 'codex'])
  assert.equal(metadataCalls, 2, 'the shared Gateway metadata is refreshed once after expiry')
})

test('Magpie /v1/models 解析上下文、token 限制、模态、推理等级和服务档位', () => {
  const metadata = parseMagpieModelMetadata({
    data: [{
      id: 'auto/gpt-6.1-sol', display_name: 'GPT-6.1 Sol-Auto', owned_by: 'codex',
      context_length: 500000, context_window: 500000,
      max_input_tokens: 500000, max_output_tokens: 128000,
      modalities: { input: ['text', 'image'] }, reasoning: true,
      reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }],
      service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
      capabilities: ['tools', 'vision'],
    }],
  })
  assert.deepEqual(metadata?.get('auto/gpt-6.1-sol'), {
    id: 'auto/gpt-6.1-sol', name: 'GPT-6.1 Sol-Auto', contextWindow: 500000,
    maxInputTokens: 500000, maxOutputTokens: 128000,
    inputModalities: ['text', 'image'], reasoningSupported: true,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
    capabilities: ['tools', 'vision'], ownedBy: 'codex',
  })
  assert.equal(parseMagpieModelMetadata({ data: [{ id: 'one/provider' }, { id: 'one/provider' }] }), null, 'duplicate IDs are ambiguous')
  assert.equal(parseMagpieModelMetadata({ data: [] }), null, 'empty responses are unavailable')

  const noReasoning = parseMagpieModelMetadata({ data: [{ id: 'provider/model', reasoning: false }] })
  assert.deepEqual(noReasoning?.get('provider/model')?.efforts, [])
})

test('Magpie /v1/magpie/quotas 只保留安全的提供商配额字段', () => {
  const quotas = parseMagpieQuotas({ data: [{
    provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', user: 'account@example.com', plan: 'Free',
    alias: 'Primary', balance: '$12.50', readAt: '2026-10-21T12:00:00Z',
    windows: [{ name: 'Credits', used: 2.5, remaining: 97.5, display: '46.94 / 2300', amount: 46.94, limit: 2300, unit: 'credits', holdsWhy: 'low' }],
    secret: 'must not pass through',
  }] })
  assert.deepEqual(quotas, [{
    provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', user: 'account@example.com', plan: 'Free', alias: 'Primary',
    balance: '$12.50', readAt: '2026-10-21T12:00:00Z',
    windows: [{ name: 'Credits', usedPercent: 2.5, remainingPercent: 97.5, resetsAt: null, display: '46.94 / 2300', amount: 46.94, limit: 2300, unit: 'credits', holdsWhy: 'low', startsAt: null, runsOut: null, runsOutAt: null }],
    // 账号级可选项在缺省时归一化为 null，供客户端稳定判断"未提供"。
    error: null,
    until: null,
    renew: null,
    credits: null,
  }])
  assert.doesNotMatch(JSON.stringify(quotas), /must not pass through/u)
  assert.equal(parseMagpieQuotas({ data: [{ provider: 'workbuddy', name: 'WorkBuddy', windows: 'invalid' }] }), null)
})

test('数量窗口的 remaining 是剩余量而不是百分比', () => {
  // 实测上游：Magpie 的 `used` 永远是 0–100 百分比，而带 amount/limit 的窗口
  // 其 `remaining` 是数量（322.25 / 2400），不能当成百分比读。
  // `remaining` 取一个明显不等于 `100 - used` 的值，否则两种读法会碰巧相等。
  const counted = parseMagpieQuotas([{
    provider: 'workbuddy', name: 'WorkBuddy', user: '白云5',
    windows: [{ name: 'Credits', used: 40, remaining: 2160, display: '1440 / 3600', amount: 1440, limit: 3600, unit: 'credits' }],
  }])
  assert.equal(counted?.[0]?.windows[0]?.usedPercent, 40)
  assert.equal(counted?.[0]?.windows[0]?.remainingPercent, 60, 'the remaining share is derived from used, not read as a count')
  // 只给上限、没有 amount 的窗口同样是数量形式（WorkBuddy AI 的 `0 / 350`）。
  const limited = parseMagpieQuotas([{
    provider: 'workbuddy-ai', name: 'WorkBuddy AI', user: 'account@example.com',
    windows: [{ name: 'Credits', used: 0, remaining: 100, display: '0 / 350', limit: 350, unit: 'credits' }],
  }])
  assert.equal(limited?.[0]?.windows[0]?.remainingPercent, 100)
  // 没有数量的窗口仍按上游给的 remaining 百分比读取。
  const percentOnly = parseMagpieQuotas([{
    provider: 'codex', name: 'Codex', user: 'me@example.com',
    windows: [{ name: '5 hours', used: 3, remaining: 97 }],
  }])
  assert.equal(percentOnly?.[0]?.windows[0]?.remainingPercent, 97)
})

test('Magpie metadata enriches exact model matches for DSH and every verified external Agent', async () => {
  const adapters = [
    ['dsh', 'dsh'], ['codex', 'codex'],
    ['claude-code', 'claude'], ['command-code', 'commandcode'], ['kimi', 'kimi'], ['gemini', 'gemini'],
    ['pi', 'pi'], ['opencode', 'opencode'], ['grok', 'grok'], ['mcode', 'minimax-code'],
    ['zcode', 'zcode'], ['codebuddy', 'codebuddy'], ['workbuddy', 'workbuddy'], ['cursor-cli', 'cursor'],
    ['qoder', 'qoder'], ['qoder-cn', 'qoder-cn'], ['antigravity', 'agy'],
  ] as const

  for (const [adapterId, agent] of adapters) {
    const cliModelId = 'example-provider/model-one'
    const modelId = agent === 'commandcode' ? `magpie/${cliModelId}` : cliModelId
    const service = new MagpieUsageService({
      readModels: async (requestedAgent) => [
        'Example provider',
        `${cliModelId}    Model One`,
        `${requestedAgent} is shown every provider's models · magpie visible ${requestedAgent}`,
        'http://127.0.0.1:3425/v1',
      ].join('\n'),
      fetch: (async (url) => {
        assert.equal(String(url), 'http://127.0.0.1:3425/v1/models')
        return Response.json({ data: [{
          id: cliModelId, display_name: 'Magpie Model One', context_window: 500000,
          max_input_tokens: 500000, max_output_tokens: 128000, reasoning: true,
          reasoning_levels: ['low', 'high'], modalities: { input: ['text', 'image'] },
        }] })
      }) as typeof fetch,
    })
    const original = {
      groups: [{ id: agent, name: agent, models: [{ id: modelId, name: 'Original label', efforts: ['old'] }] }],
      currentModel: modelId, currentEffort: 'old',
    }
    const enriched = await service.enrichModelCatalog(adapterId, original)
    const model = enriched.groups[0]!.models[0]!
    assert.equal(model.source, 'magpie', adapterId)
    assert.equal(model.name, 'Magpie Model One', adapterId)
    assert.equal(model.contextWindow, 500000, adapterId)
    assert.equal(model.maxInputTokens, 500000, adapterId)
    assert.equal(model.maxOutputTokens, 128000, adapterId)
    assert.deepEqual(model.inputModalities, ['text', 'image'], adapterId)
    assert.deepEqual(model.efforts, ['low', 'high'], adapterId)
  }
})

test('Magpie metadata uses only exact CLI/API IDs and leaves unsupported catalogs untouched', async () => {
  let gatewayReads = 0
  const service = new MagpieUsageService({
    readModels: async () => [
      'Example provider',
      'auto/gpt-6.1-sol    GPT-6.1 Sol-Auto',
      "codex is shown every provider's models · magpie visible codex",
      'http://127.0.0.1:3425/v1',
    ].join('\n'),
    fetch: (async () => {
      gatewayReads += 1
      return Response.json({ data: [
        { id: 'auto/gpt-6.1-sol', context_window: 500000, reasoning_levels: ['low', 'high'] },
        { id: 'codex/gpt-6.1-sol', context_window: 500000 },
        { id: 'glorinfo-api-platform/gpt-6.1-sol', context_window: 922000 },
      ] })
    }) as typeof fetch,
  })

  const auto = await service.readModelMetadata('codex', 'auto/gpt-6.1-sol')
  assert.equal(auto?.contextWindow, 500000)
  assert.deepEqual(auto?.efforts, ['low', 'high'])
  assert.equal(await service.readModelMetadata('codex', 'codex/gpt-6.1-sol'), null)
  assert.equal(await service.readModelMetadata('codex', 'glorinfo-api-platform/gpt-6.1-sol'), null)
  assert.equal(gatewayReads, 1)

  const ordinary = {
    groups: [{ id: 'claude', name: 'Claude', models: [{ id: 'example-provider/not-listed', name: 'Normal', efforts: [] }] }],
    currentModel: null, currentEffort: null,
  }
  const untouched = await service.enrichModelCatalog('claude-code', ordinary)
  assert.equal(untouched, ordinary)
  assert.equal(gatewayReads, 1, 'non-Magpie model rows never trigger a second request')

  const exactCatalog = await service.enrichModelCatalog('codex', {
    groups: [{ id: 'codex', name: 'Codex', models: [
      { id: 'auto/gpt-6.1-sol', name: 'Original auto', efforts: [] },
      { id: 'codex/gpt-6.1-sol', name: 'Codex native', efforts: [] },
      { id: 'glorinfo-api-platform/gpt-6.1-sol', name: 'Other provider', efforts: [] },
    ] }], currentModel: null, currentEffort: null,
  })
  assert.deepEqual(exactCatalog.groups[0]!.models.map((model) => model.source), ['magpie', undefined, undefined])
})

test('Codex catalog includes verified Magpie-only models missing from model/list', async () => {
  const service = new MagpieUsageService({
    readModels: async () => [
      'Routing groups',
      'auto/gpt-6.1-sol    GPT-6.1 Sol-Auto',
      'sub2api/deepseek-v4.1-flash    DeepSeek V4.1 Flash',
      'workbuddy/another-model    WorkBuddy Model',
      "codex is shown every provider's models · magpie visible codex",
      'http://127.0.0.1:3425/v1',
    ].join('\n'),
    fetch: (async (url) => {
      assert.equal(String(url), 'http://127.0.0.1:3425/v1/models')
      return Response.json({ data: [
        { id: 'auto/gpt-6.1-sol', display_name: 'GPT-6.1 Sol-Auto', context_window: 500000, reasoning_levels: ['low', 'high'] },
        { id: 'sub2api/deepseek-v4.1-flash', display_name: 'DeepSeek V4.1 Flash', context_window: 1048576, reasoning_levels: ['low', 'high', 'max'] },
      ] })
    }) as typeof fetch,
  })
  const catalog = await service.enrichModelCatalog('codex', {
    groups: [{ id: 'codex', name: 'Codex', models: [
      { id: 'provider-default', name: 'Follow Codex default', efforts: [] },
      { id: 'gpt-5.4', name: 'gpt-5.4', efforts: ['low', 'high'] },
    ] }],
    currentModel: 'gpt-5.4', currentEffort: 'high',
  })

  const models = catalog.groups[0]!.models
  assert.deepEqual(models.map((model) => model.id), [
    'provider-default', 'gpt-5.4', 'auto/gpt-6.1-sol', 'sub2api/deepseek-v4.1-flash', 'workbuddy/another-model',
  ])
  assert.equal(models[1]!.source, undefined, 'native Codex choices remain native')
  assert.equal(models[2]!.name, 'GPT-6.1 Sol-Auto')
  assert.equal(models[2]!.contextWindow, 500000)
  assert.deepEqual(models[2]!.efforts, ['low', 'high'])
  assert.equal(models[3]!.contextWindow, 1048576)
  assert.deepEqual(models[3]!.efforts, ['low', 'high', 'max'])
  assert.equal(models[4]!.name, 'WorkBuddy Model', 'CLI label remains available if Gateway metadata omits a row')
  assert.deepEqual(catalog.groups[0]!.models.at(-1), {
    id: 'workbuddy/another-model', name: 'WorkBuddy Model', efforts: [], source: 'magpie',
  })
  assert.equal(catalog.currentModel, 'gpt-5.4')
  assert.equal(catalog.currentEffort, 'high')

  const alreadyListed = await service.enrichModelCatalog('codex', {
    groups: [{ id: 'codex', name: 'Codex', models: [
      { id: 'auto/gpt-6.1-sol', name: 'Existing Magpie model', efforts: [] },
    ] }],
    currentModel: 'auto/gpt-6.1-sol', currentEffort: null,
  })
  assert.equal(alreadyListed.groups[0]!.models.filter((model) => model.id === 'auto/gpt-6.1-sol').length, 1)

  const unavailableMagpie = new MagpieUsageService({ readModels: async () => null })
  const original = { groups: [{ id: 'codex', name: 'Codex', models: [{ id: 'gpt-5.4', name: 'gpt-5.4', efforts: [] }] }], currentModel: 'gpt-5.4', currentEffort: null }
  assert.equal(await unavailableMagpie.enrichModelCatalog('codex', original), original)
})

test('Magpie metadata joins unique display names when Agent model IDs differ', async () => {
  let metadataReads = 0
  const service = new MagpieUsageService({
    readModels: async () => [
      'Routing groups',
      'auto/gpt-6.1-sol    GPT-6.1 Sol-Auto',
      'auto/deepseek-v4.1-flash    Deepseek-V4.1-Flash-Auto',
      "codex is shown every provider's models · magpie visible codex",
      'http://127.0.0.1:3425/v1',
    ].join('\n'),
    fetch: (async (url) => {
      assert.equal(String(url), 'http://127.0.0.1:3425/v1/models')
      metadataReads += 1
      return Response.json({ data: [
        { id: 'auto/gpt-6.1-sol', display_name: 'GPT-6.1 Sol-Auto', context_window: 500000, max_input_tokens: 500000, max_output_tokens: 128000, reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        { id: 'auto/deepseek-v4.1-flash', display_name: 'Deepseek-V4.1-Flash-Auto', context_window: 1048576, reasoning_levels: ['low', 'high', 'max'] },
      ] })
    }) as typeof fetch,
  })
  const catalog = await service.enrichModelCatalog('codex', {
    groups: [{ id: 'codex', name: 'Codex', models: [
      { id: 'native/sol-auto', name: 'GPT-6.1 Sol-Auto', efforts: [] },
      { id: 'native/deepseek-auto', name: 'Deepseek-V4.1-Flash-Auto', efforts: [] },
      { id: 'native/unknown', name: 'Unlisted model', efforts: [] },
    ] }], currentModel: null, currentEffort: null,
  })
  const models = catalog.groups[0]!.models
  assert.equal(metadataReads, 1)
  assert.equal(models[0]!.source, 'magpie')
  assert.equal(models[0]!.contextWindow, 500000)
  assert.equal(models[0]!.maxInputTokens, 500000)
  assert.deepEqual(models[0]!.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  assert.equal(models[1]!.source, 'magpie')
  assert.equal(models[1]!.contextWindow, 1048576)
  assert.deepEqual(models[1]!.efforts, ['low', 'high', 'max'])
  assert.equal(models[2]!.source, undefined)
})

test('Magpie display-name aliases enrich every verified Agent catalog', async () => {
  const adapters = [
    ['dsh', 'dsh'], ['codex', 'codex'], ['claude-code', 'claude'], ['command-code', 'commandcode'],
    ['kimi', 'kimi'], ['gemini', 'gemini'], ['pi', 'pi'], ['opencode', 'opencode'], ['grok', 'grok'],
    ['mcode', 'minimax-code'], ['zcode', 'zcode'], ['codebuddy', 'codebuddy'], ['workbuddy', 'workbuddy'],
    ['cursor-cli', 'cursor'], ['qoder', 'qoder'], ['qoder-cn', 'qoder-cn'], ['antigravity', 'agy'],
  ] as const
  for (const [adapterId, agent] of adapters) {
    const service = new MagpieUsageService({
      readModels: async (requestedAgent) => [
        'Routing groups', 'provider/magpie-model    Magpie Model',
        `${requestedAgent} is shown every provider's models · magpie visible ${requestedAgent}`,
        'http://127.0.0.1:3425/v1',
      ].join('\n'),
      fetch: (async () => Response.json({ data: [{
        id: 'provider/magpie-model', display_name: 'Magpie Model', context_window: 500000,
        reasoning_levels: ['low', 'high'],
      }] })) as typeof fetch,
    })
    const result = await service.enrichModelCatalog(adapterId, {
      groups: [{ id: agent, name: agent, models: [{ id: `native/${agent}/model`, name: 'Magpie Model', efforts: [] }] }],
      currentModel: null, currentEffort: null,
    })
    const model = result.groups[0]!.models[0]!
    assert.equal(model.source, 'magpie', adapterId)
    assert.equal(model.contextWindow, 500000, adapterId)
    assert.deepEqual(model.efforts, ['low', 'high'], adapterId)
  }
})

test('Magpie enriches ID-only CLI rows from the exact /v1/models record', async () => {
  const service = new MagpieUsageService({
    readModels: async () => [
      'Routing groups', 'sub2api/deepseek-v4.1-flash',
      "claude is shown every provider's models · magpie visible claude", 'http://127.0.0.1:3425/v1',
    ].join('\n'),
    fetch: (async () => Response.json({ data: [{
      id: 'sub2api/deepseek-v4.1-flash', display_name: 'DeepSeek V4.1 Flash',
      context_window: 1048576, max_input_tokens: 1048576, max_output_tokens: 65536,
      reasoning_levels: [],
    }] })) as typeof fetch,
  })

  const metadata = await service.readModelMetadata('claude-code', 'sub2api/deepseek-v4.1-flash')
  assert.equal(metadata?.contextWindow, 1048576)
  assert.deepEqual(metadata?.efforts, [])

  const catalog = await service.enrichModelCatalog('claude-code', {
    groups: [{ id: 'claude', name: 'Claude', models: [{
      id: 'sub2api/deepseek-v4.1-flash', name: 'Original label', efforts: ['stale'],
    }] }], currentModel: null, currentEffort: null,
  })
  const model = catalog.groups[0]!.models[0]!
  assert.equal(model.source, 'magpie')
  assert.equal(model.name, 'DeepSeek V4.1 Flash')
  assert.equal(model.contextWindow, 1048576)
  assert.equal(model.maxInputTokens, 1048576)
  assert.deepEqual(model.efforts, [])
})

test('Magpie 标记依赖准确的 Agent 目录匹配，不因 Gateway 元数据不可用而丢失', async () => {
  const service = new MagpieUsageService({
    readModels: async () => [
      'Example provider', 'example-provider/model-one    Model One',
      "claude is shown every provider's models · magpie visible claude", 'http://127.0.0.1:3425/v1',
    ].join('\n'),
    fetch: (async () => { throw new Error('gateway unavailable') }) as typeof fetch,
  })
  const catalog = await service.enrichModelCatalog('claude-code', {
    groups: [{ id: 'claude', name: 'Claude', models: [
      { id: 'example-provider/model-one', name: 'Model One', efforts: ['low', 'high'] },
      { id: 'example-provider/model-not-listed', name: 'Ordinary', efforts: [] },
    ] }], currentModel: null, currentEffort: null,
  })
  assert.deepEqual(catalog.groups[0]!.models.map((model) => model.source), ['magpie', undefined])
  assert.deepEqual(catalog.groups[0]!.models[0]!.efforts, ['low', 'high'])
})

test('Magpie reasoning false clears stale levels, while missing fields retain Agent metadata', async () => {
  const service = new MagpieUsageService({
    readModels: async () => [
      'Example provider', 'provider/no-reasoning    No Reasoning', 'provider/partial    Partial',
      "claude is shown every provider's models · magpie visible claude", 'http://127.0.0.1:3425/v1',
    ].join('\n'),
    fetch: (async () => Response.json({ data: [
      { id: 'provider/no-reasoning', reasoning: false },
      { id: 'provider/partial', context_window: 256000 },
    ] })) as typeof fetch,
  })
  const original = {
    groups: [{ id: 'claude', name: 'Claude', models: [
      { id: 'provider/no-reasoning', name: 'No Reasoning', efforts: ['high'] },
      { id: 'provider/partial', name: 'Partial', efforts: ['low', 'high'], maxOutputTokens: 32000 },
    ] }], currentModel: null, currentEffort: null,
  }
  const enriched = await service.enrichModelCatalog('claude-code', original)
  assert.deepEqual(enriched.groups[0]!.models[0]!.efforts, [])
  assert.equal(enriched.groups[0]!.models[1]!.contextWindow, 256000)
  assert.equal(enriched.groups[0]!.models[1]!.maxOutputTokens, 32000)
  assert.deepEqual(enriched.groups[0]!.models[1]!.efforts, ['low', 'high'])
})

test('Magpie compact usage reads only Web API usage and exact session ledger data', async () => {
  const calls: Array<{ url: string; method: string }> = []
  const fetcher = (async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url: `${url.pathname}${url.search}`, method: init?.method ?? 'GET' })
    if (url.pathname === '/api/usage/requests') return Response.json({ rows: [{
      route_id: 7, t: '2026-10-20T11:59:00Z', agent: 'claude', session: 'agent-session-1',
      req: 'example-provider/model-one', provider: 'example-provider', providerAccount: 'primary',
      model: 'example-provider/model-one', served: 'example-provider/model-one', effort: 'high', status: 200,
    }] })
    if (url.pathname === '/api/usage/quotas') return Response.json({ data: [{ provider: 'example-provider', name: 'Example Provider', user: 'primary', windows: [] }] })
    return Response.json(usageReply())
  }) as typeof fetch
  const service = new MagpieUsageService({
    readModels: async () => { throw new Error('compact usage must not call Magpie CLI') },
    readVersion: async () => { throw new Error('compact usage must not check Magpie CLI version') },
    now: () => Date.parse('2026-10-20T12:00:00.000Z'),
    webApi: fakeMagpieWebApi(fetcher),
  })

  const result = await service.read({ adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true)
  assert.deepEqual(calls.map((call) => call.url), [
    '/api/usage?period=today',
    '/api/usage/quotas',
    '/api/usage/requests?period=today&offset=0&limit=100&q=agent-session-1',
  ])
  assert.ok(calls.every((call) => call.method === 'GET'))
  assert.equal(result?.usageStatus, 'available')
  assert.deepEqual(result?.aggregate, { calls: 3, errors: 1, inputTokens: 300, outputTokens: 90, cacheReadTokens: 20, cacheWriteTokens: 8, costUsd: 0.0325 })
  assert.deepEqual(result?.session, { id: 'agent-session-1', agent: 'claude', calls: null, errors: null, inputTokens: 120, outputTokens: 30, cacheReadTokens: 12, cacheWriteTokens: 4, costUsd: 0.0125 })
  assert.equal(result?.routeStatus, 'available')
  assert.equal(result?.route?.asked, 'example-provider/model-one')
  assert.equal(result?.route?.routeId, 7)
  assert.equal(result?.upstreamProvider, 'example-provider')
  assert.deepEqual(result?.upstreamProviders, ['example-provider'])
  // 路由精确指向 primary，因此该账号被标记为本会话正在使用的账号。
  assert.deepEqual(result?.quotas, [{
    provider: 'example-provider', name: 'Example Provider', kind: null, user: 'primary', plan: null, alias: null, balance: null, readAt: null,
    windows: [], active: true, error: null, until: null, renew: null, credits: null,
  }])
  assert.doesNotMatch(JSON.stringify(result), /Bearer|Authorization|prompt|response body/u)
})

test('Magpie usage service without the Host-owned Web API fails closed instead of starting a process', async () => {
  const service = new MagpieUsageService({
    readModels: async () => { throw new Error('usage must not call Magpie CLI') },
    readVersion: async () => { throw new Error('usage must not check Magpie CLI version') },
  })
  const dashboard = await service.readDashboard('today')
  assert.equal(dashboard.availabilityIssue, 'web-api-unavailable')
  assert.equal(await service.read({
    adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1',
  }), null)
})

test('Magpie 的持久请求记录补足过期路由，并只关联此会话用过的上游账号配额', async () => {
  const modelOutput = [
    'Routing groups', 'auto/deepseek-v4.1-flash    Deepseek-V4.1-Flash-Auto',
    "claude is shown every provider's models · magpie visible claude", 'http://127.0.0.1:3425/v1',
  ].join('\n')
  const sessionId = 'claude-history-session'
  const service = createWebUsageService({
    readModels: async () => modelOutput,
    fetch: (async (url) => {
      const target = new URL(String(url))
      if (target.pathname.endsWith('/quotas')) return Response.json({ data: [
        { provider: 'workbuddy', name: 'WorkBuddy', user: 'Account A', windows: [{ name: 'Credits', remaining: 70 }] },
        { provider: 'workbuddy', name: 'WorkBuddy', user: 'Account B', windows: [{ name: 'Credits', remaining: 80 }] },
        { provider: 'workbuddy', name: 'WorkBuddy', user: 'Unrelated account', windows: [{ name: 'Credits', remaining: 99 }] },
        { provider: 'workbuddy-ai', name: 'WorkBuddy AI', user: 'AI account', windows: [{ name: 'Credits', remaining: 90 }] },
      ] })
      if (target.pathname.endsWith('/route')) return Response.json({ session: sessionId, seq: 0, route: null })
      if (target.pathname.endsWith('/usage/requests')) {
        assert.equal(target.searchParams.get('q'), sessionId)
        assert.equal(target.searchParams.get('period'), 'today')
        return Response.json({ rows: [
          { route_id: 110, t: '2026-10-21T14:00:00Z', agent: 'claude', session: sessionId, req: 'group/auto-deepseek-v4-1-flash', provider: 'workbuddy', providerAccount: 'Account B', model: 'deepseek-v4.1-flash', served: 'deepseek-v4.1-flash', effort: 'high', status: 200 },
          { route_id: 109, t: '2026-10-21T13:00:00Z', agent: 'claude', session: sessionId, req: 'group/auto-deepseek-v4-1-flash', provider: 'workbuddy-ai', providerAccount: 'AI account', model: 'deepseek-v4.1-flash', served: 'deepseek-v4.1-flash', status: 200 },
          { route_id: 108, t: '2026-10-21T12:00:00Z', agent: 'claude', session: sessionId, req: 'group/auto-deepseek-v4-1-flash', provider: 'workbuddy', providerAccount: 'Account A', model: 'deepseek-v4.1-flash', served: 'deepseek-v4.1-flash', status: 200 },
          { route_id: 107, t: '2026-10-21T11:00:00Z', agent: 'claude', session: 'another-session', req: 'group/auto-deepseek-v4-1-flash', provider: 'workbuddy', providerAccount: 'Unrelated account', model: 'deepseek-v4.1-flash', served: 'deepseek-v4.1-flash', status: 200 },
        ] })
      }
      return Response.json(usageReply([{ agent: 'claude', id: sessionId, input: 8, output: 2, cost: 0.001 }]))
    }) as typeof fetch,
  })

  const result = await service.read({
    adapterId: 'claude-code', modelId: 'auto/deepseek-v4.1-flash[1m]', providerSessionId: sessionId,
  }, undefined, true)
  assert.equal(result?.routeStatus, 'available')
  assert.equal(result?.route?.asked, 'group/auto-deepseek-v4-1-flash')
  assert.equal(result?.route?.group, 'auto-deepseek-v4-1-flash')
  assert.equal(result?.route?.model, 'workbuddy/deepseek-v4.1-flash')
  assert.equal(result?.route?.providerAccount, 'Account B')
  assert.equal(result?.route?.routeId, 110)
  assert.deepEqual(result?.upstreamProviders, ['workbuddy', 'workbuddy-ai'])
  assert.deepEqual(result?.quotas.map((quota) => [quota.provider, quota.user]), [
    ['workbuddy', 'Account A'], ['workbuddy', 'Account B'], ['workbuddy-ai', 'AI account'],
  ])
})

test('Magpie 不会在账号不匹配时回退显示该提供商唯一的其他账号配额', async () => {
  const sessionId = 'claude-account-mismatch-session'
  const modelOutput = [
    'Routing groups', 'workbuddy/deepseek-v4.1-flash    Deepseek-V4.1-Flash',
    "claude is shown every provider's models · magpie visible claude", 'http://127.0.0.1:3425/v1',
  ].join('\n')
  const service = createWebUsageService({
    readModels: async () => modelOutput,
    fetch: (async (url) => {
      const target = new URL(String(url))
      if (target.pathname.endsWith('/quotas')) return Response.json({ data: [
        { provider: 'workbuddy', name: 'WorkBuddy', user: 'Different account', windows: [{ name: 'Credits', remaining: 95 }] },
      ] })
      if (target.pathname.endsWith('/route')) return Response.json({ session: sessionId, seq: 0, route: null })
      if (target.pathname.endsWith('/usage/requests')) return Response.json({ rows: [
        { route_id: 80, t: '2026-10-21T14:00:00Z', agent: 'claude', session: sessionId, req: 'workbuddy/deepseek-v4.1-flash', provider: 'workbuddy', providerAccount: 'Session account', model: 'deepseek-v4.1-flash', served: 'deepseek-v4.1-flash', status: 200 },
      ] })
      return Response.json(usageReply([{ agent: 'claude', id: sessionId, input: 4, output: 2, cost: 0.001 }]))
    }) as typeof fetch,
  })

  const result = await service.read({ adapterId: 'claude-code', modelId: 'workbuddy/deepseek-v4.1-flash', providerSessionId: sessionId }, undefined, true)
  assert.equal(result?.routeStatus, 'available')
  assert.deepEqual(result?.upstreamProviders, ['workbuddy'])
  assert.equal(result?.quotaStatus, 'available')
  assert.deepEqual(result?.quotas, [], 'a different account quota must not be attributed to this session')
})

test('Claude [1m] model markers do not block verified Magpie usage', async () => {
  const service = createWebUsageService({
    readModels: async () => [
      'Routing groups', 'auto/deepseek-v4.1-flash    Deepseek-V4.1-Flash-Auto',
      "claude is shown every provider's models · magpie visible claude", 'http://127.0.0.1:3425/v1',
    ].join('\n'),
    fetch: (async (url) => String(url).includes('/quotas')
      ? Response.json({ data: [{ provider: 'sub2api', name: 'sub2api', windows: [], alias: 'DeepSeek' }] })
      : Response.json(usageReply([{ agent: 'claude', id: 'claude-session-1', input: 8, output: 2, cost: 0.001 }]))) as typeof fetch,
  })

  const result = await service.read({
    adapterId: 'claude-code',
    modelId: 'auto/deepseek-v4.1-flash[1m]',
    providerSessionId: 'claude-session-1',
  })
  assert.ok(result, 'Claude model IDs with the context marker should match Magpie')
  assert.equal(result.usageStatus, 'available')
  assert.equal(result.session?.id, 'claude-session-1')
})

test('DSH 用 Magpie 的实际网关 client 身份关联会话、路由和上游配额', async () => {
  const modelOutput = [
    'Routing groups', 'auto/gpt-6.1-sol    GPT-6.1 Sol-Auto',
    "dsh is shown every provider's models · magpie visible dsh", 'http://127.0.0.1:3425/v1',
  ].join('\n')
  const urls: URL[] = []
  const service = createWebUsageService({
    readModels: async () => modelOutput,
    fetch: (async (url) => {
      const target = new URL(String(url))
      urls.push(target)
      if (target.pathname.endsWith('/usage/requests')) return Response.json({ rows: [{
        route_id: 15, t: '2026-10-21T14:00:00Z', agent: 'codingns4dsh', session: 'dsh-provider-session',
        req: 'group/auto-gpt-6-1-sol', provider: 'glorinfo-api-platform', model: 'gpt-6.1-sol',
        served: 'gpt-6.1-sol', status: 200,
      }] })
      if (target.pathname.endsWith('/quotas')) return Response.json({ data: [{ provider: 'glorinfo-api-platform', name: 'GAP-Codex', windows: [] }] })
      return Response.json(usageReply([{ agent: 'codingns4dsh', id: 'dsh-provider-session', input: 12, output: 4, cost: 0.001 }]))
    }) as typeof fetch,
  })

  const result = await service.read({ adapterId: 'dsh', modelId: 'auto/gpt-6.1-sol', providerSessionId: 'dsh-provider-session' }, undefined, true)
  assert.equal(result?.session?.agent, 'codingns4dsh')
  assert.equal(result?.session?.inputTokens, 12)
  assert.equal(result?.routeStatus, 'available')
  assert.equal(result?.upstreamProvider, 'glorinfo-api-platform')
  assert.deepEqual(result?.upstreamProviders, ['glorinfo-api-platform'])
  assert.equal(result?.quotas[0]?.name, 'GAP-Codex')
  assert.ok(urls.some(url => url.pathname === '/api/usage' && url.searchParams.get('period') === 'today'))
  assert.ok(urls.some(url => url.pathname === '/api/usage/requests' && url.searchParams.get('q') === 'dsh-provider-session'))
})

test('原生 DSH 使用 DSH 会话 ID 关联 Magpie 用量、路由和上游配额', async () => {
  const sessionId = 'native-dsh-session'
  const modelOutput = [
    'Routing groups', 'auto/gpt-6.1-sol    GPT-6.1 Sol-Auto',
    "dsh is shown every provider's models · magpie visible dsh", 'http://127.0.0.1:3425/v1',
  ].join('\n')
  const service = createWebUsageService({
    readModels: async () => modelOutput,
    fetch: (async (url) => {
      const target = new URL(String(url))
      if (target.pathname.endsWith('/quotas')) return Response.json({ data: [{
        provider: 'glorinfo-api-platform', name: 'GAP-Codex', windows: [{ name: 'Credits', remaining: 73 }],
      }] })
      if (target.pathname.endsWith('/route')) return Response.json({
        session: sessionId,
        route: { id: 42, asked: 'auto/gpt-6.1-sol', model: 'glorinfo-api-platform/gpt-6.1-sol', served: 'gpt-6.1-sol', done: true, status: 200, tries: [] },
      })
      if (target.pathname.endsWith('/usage/requests')) return Response.json({ rows: [{
        route_id: 42, t: '2026-10-21T14:00:00Z', agent: 'dsh', session: sessionId,
        provider: 'glorinfo-api-platform', model: 'gpt-6.1-sol', served: 'gpt-6.1-sol', status: 200,
      }] })
      return Response.json(usageReply([{
        agent: 'dsh', id: sessionId, input: 8, output: 2, cost: 0.001,
      }]))
    }) as typeof fetch,
  })

  const result = await service.read({
    adapterId: 'dsh',
    modelId: 'auto/gpt-6.1-sol',
  }, undefined, true, sessionId)
  assert.equal(result?.session?.agent, 'dsh')
  assert.equal(result?.session?.id, sessionId)
  assert.equal(result?.routeStatus, 'available')
  assert.equal(result?.route?.routeId, 42)
  assert.deepEqual(result?.upstreamProviders, ['glorinfo-api-platform'])
  assert.deepEqual(result?.quotas.map((quota) => quota.provider), ['glorinfo-api-platform'])
})

test('原生 DSH 的待用模型优先于上次使用模型以识别 Magpie 用量', async () => {
  const sessionId = 'native-dsh-next-model'
  const registry = new CodingNsCliAdapterRegistry([], {}, {
    nativeSessions: {
      get: () => ({
        modelSelection: {
          lastUsed: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
          next: { provider: 'magpie', model: 'auto/deepseek-v4.1-flash' },
        },
      }),
    } as never,
  })
  try {
    registry.setSession(sessionId, {
      adapterId: 'dsh',
      providerId: 'deepseek',
      modelId: 'deepseek-v4.1-flash',
    })
    const session = registry.getSession(sessionId)
    assert.equal(session.modelId, 'auto/deepseek-v4.1-flash')
    assert.equal(session.providerId, 'magpie')

    const service = createWebUsageService({
      readModels: async (agent) => [
        'Routing groups', 'auto/deepseek-v4.1-flash    DeepSeek V4.1 Flash Auto',
        `${agent} is shown every provider's models · magpie visible ${agent}`,
        'http://127.0.0.1:3425/v1',
      ].join('\n'),
      fetch: (async () => Response.json(usageReply([{ agent: 'dsh', id: sessionId, input: 1, output: 1, cost: 0.001 }]))) as typeof fetch,
    })
    assert.notEqual(await service.read(session, undefined, false, sessionId), null)
  } finally {
    await registry.dispose()
  }
})

test('尚无路由时不把 auto 模型别名冒充成上游提供商', async () => {
  const service = createWebUsageService({
    readModels: async () => [
      'Routing groups', 'auto/gpt-6.1-sol    GPT-6.1 Sol-Auto',
      "dsh is shown every provider's models · magpie visible dsh", 'http://127.0.0.1:3425/v1',
    ].join('\n'),
    fetch: (async (url) => String(url).includes('/quotas')
      ? Response.json({ data: [] })
      : Response.json(usageReply([{ agent: 'codingns4dsh', id: 'dsh-auto-session', input: 1, output: 1, cost: 0 }])) ) as typeof fetch,
  })
  const result = await service.read({ adapterId: 'dsh', modelId: 'auto/gpt-6.1-sol', providerSessionId: 'dsh-auto-session' })
  assert.equal(result?.upstreamProvider, null)
  assert.equal(result?.quotaStatus, 'provider-unavailable')
})

test('Codex 仅使用 Codex 目录与精确匹配的 Codex 会话', async () => {
  let cliReads = 0
  const urls: string[] = []
  const service = createWebUsageService({
    readModels: async () => { cliReads += 1; return null },
    fetch: (async (url) => {
      urls.push(String(url))
      return Response.json(usageReply([{ agent: 'codex', id: 'codex-thread-7', input: 8, output: 2, cost: 0.001 }]))
    }) as typeof fetch,
  })
  const result = await service.read({ adapterId: 'codex', modelId: 'example-provider/model-one', providerSessionId: 'codex-thread-7' })
  assert.equal(cliReads, 0, 'compact usage does not shell out to Magpie CLI')
  assert.deepEqual(urls, [
    'http://127.0.0.1:3430/api/usage?period=today',
    'http://127.0.0.1:3430/api/usage/quotas',
  ])
  assert.equal(result?.agent, 'codex')
  assert.equal(result?.session?.id, 'codex-thread-7')
  assert.equal(result?.routeStatus, 'not-requested')
})

test('Command Code 的 magpie/provider/model 拼法按 Magpie 目录精确匹配', async () => {
  const modelOutput = [
    'Example provider',
    'example-provider/model-one    Model One',
    "commandcode is shown every provider's models · magpie visible commandcode",
    'http://127.0.0.1:3425/v1',
  ].join('\n')
  const service = createWebUsageService({
    readModels: async (agent) => { assert.equal(agent, 'commandcode'); return modelOutput },
    fetch: (async () => Response.json(usageReply([{ agent: 'commandcode', id: 'command-session-1', input: 8, output: 2, cost: 0.001 }]))) as typeof fetch,
  })
  const result = await service.read({
    adapterId: 'command-code', modelId: 'magpie/example-provider/model-one', providerSessionId: 'command-session-1',
  })
  assert.equal(result?.usageStatus, 'available')
  assert.equal(result?.modelId, 'magpie/example-provider/model-one')
  assert.equal(result?.session?.id, 'command-session-1')
})

test('Command Code 使用 CodingNS 网关 Agent 身份时仍能关联会话、路由和配额', async () => {
  const sessionId = 'command-code-codingns-session'
  const modelOutput = [
    'Example provider',
    'example-provider/model-one    Model One',
    "commandcode is shown every provider's models · magpie visible commandcode",
    'http://127.0.0.1:3425/v1',
  ].join('\n')
  const service = createWebUsageService({
    readModels: async () => modelOutput,
    fetch: (async (url) => {
      const target = new URL(String(url))
      if (target.pathname.endsWith('/quotas')) return Response.json({ data: [{
        provider: 'example-provider', name: 'Example Provider', user: null, windows: [{ name: 'Credits', remaining: 73 }],
      }] })
      if (target.pathname.endsWith('/route')) return Response.json({
        session: sessionId,
        route: { id: 42, asked: 'example-provider/model-one', model: 'example-provider/model-one', served: 'model-one', done: true, status: 200, tries: [] },
      })
      if (target.pathname.endsWith('/usage/requests')) return Response.json({ rows: [{
        route_id: 42, t: '2026-10-21T14:00:00Z', agent: 'codingns4dsh', session: sessionId,
        provider: 'example-provider', model: 'model-one', served: 'model-one', status: 200,
      }] })
      return Response.json(usageReply([{
        agent: 'codingns4dsh', id: sessionId, input: 8, output: 2, cost: 0.001,
      }]))
    }) as typeof fetch,
  })

  const result = await service.read({
    adapterId: 'command-code',
    modelId: 'magpie/example-provider/model-one',
    providerSessionId: sessionId,
  }, undefined, true)
  assert.equal(result?.session?.agent, 'codingns4dsh')
  assert.equal(result?.session?.id, sessionId)
  assert.equal(result?.routeStatus, 'available')
  assert.equal(result?.route?.routeId, 42)
  assert.deepEqual(result?.upstreamProviders, ['example-provider'])
  assert.deepEqual(result?.quotas.map((quota) => quota.provider), ['example-provider'])
})

test('Command Code 使用 Host 注入的 DSH 会话 ID 归档，同时保留 ACP 会话 ID 展示', async () => {
  const providerSessionId = 'command-acp-session'
  const dshSessionId = 'session-command-code'
  const urls: string[] = []
  const service = createWebUsageService({
    readModels: async () => [
      'Example provider',
      'example-provider/model-one    Model One',
      "commandcode is shown every provider's models · magpie visible commandcode",
      'http://127.0.0.1:3425/v1',
    ].join('\n'),
    fetch: (async (url) => {
      const target = new URL(String(url))
      urls.push(`${target.pathname}${target.search}`)
      if (target.pathname.endsWith('/quotas')) return Response.json({ data: [] })
      if (target.pathname.endsWith('/route')) return Response.json({
        session: dshSessionId,
        route: { id: 7, asked: 'example-provider/model-one', model: 'example-provider/model-one', served: 'model-one', done: true, status: 200, tries: [] },
      })
      if (target.pathname.endsWith('/usage/requests')) return Response.json({ rows: [{
        route_id: 7, t: '2026-10-22T05:00:00Z', agent: 'commandcode', session: dshSessionId,
        provider: 'example-provider', model: 'model-one', served: 'model-one', status: 200,
      }] })
      return Response.json(usageReply([{
        agent: 'commandcode', id: dshSessionId, input: 8, output: 2, cost: 0.001,
      }]))
    }) as typeof fetch,
  })

  const result = await service.read({
    adapterId: 'command-code',
    modelId: 'magpie/example-provider/model-one',
    providerSessionId,
  }, undefined, true, dshSessionId)
  assert.equal(result?.sessionId, providerSessionId)
  assert.equal(result?.session?.id, dshSessionId)
  assert.equal(result?.session?.agent, 'commandcode')
  assert.equal(result?.routeStatus, 'available')
  assert.equal(result?.route?.routeId, 7)
  assert.ok(urls.some((url) => url.includes(`q=${dshSessionId}`)))
  assert.ok(urls.every((url) => !url.includes(`q=${providerSessionId}`)))
})

test('Command Code 旧 ACP 子进程仍按 ACP 会话 ID 归档时面板能回退关联', async () => {
  const providerSessionId = 'command-acp-session'
  const dshSessionId = 'session-command-code'
  const urls: string[] = []
  const service = createWebUsageService({
    readModels: async () => [
      'Example provider',
      'example-provider/model-one    Model One',
      "commandcode is shown every provider's models · magpie visible commandcode",
      'http://127.0.0.1:3425/v1',
    ].join('\n'),
    fetch: (async (url) => {
      const target = new URL(String(url))
      urls.push(`${target.pathname}${target.search}`)
      if (target.pathname.endsWith('/quotas')) return Response.json({ data: [] })
      if (target.pathname.endsWith('/route')) return Response.json({
        session: providerSessionId,
        route: { id: 9, asked: 'example-provider/model-one', model: 'example-provider/model-one', served: 'model-one', done: true, status: 200, tries: [] },
      })
      if (target.pathname.endsWith('/usage/requests')) return Response.json({ rows: [{
        route_id: 9, t: '2026-10-22T08:41:00Z', agent: 'commandcode', session: providerSessionId,
        provider: 'example-provider', model: 'model-one', served: 'model-one', status: 200,
      }] })
      return Response.json(usageReply([{
        agent: 'commandcode', id: providerSessionId, input: 8, output: 2, cost: 0.001,
      }]))
    }) as typeof fetch,
  })

  const result = await service.read({
    adapterId: 'command-code',
    modelId: 'magpie/example-provider/model-one',
    providerSessionId,
  }, undefined, true, dshSessionId)
  assert.equal(result?.sessionId, providerSessionId)
  assert.equal(result?.session?.id, providerSessionId)
  assert.equal(result?.routeStatus, 'available')
  assert.equal(result?.route?.routeId, 9)
  assert.ok(urls.some((url) => url.includes(`q=${providerSessionId}`)))
})

test('Magpie does not treat a DSH session ID as a provider session ID', async () => {
  const urls: string[] = []
  let cliReads = 0
  const service = createWebUsageService({
    readModels: async () => { cliReads += 1; return null },
    fetch: (async (url) => {
      urls.push(String(url))
      return Response.json(usageReply([{ agent: 'codex', id: 'shared-id', input: 8, output: 2, cost: 0.001 }]))
    }) as typeof fetch,
  })

  const result = await service.read(
    { adapterId: 'codex', modelId: 'example-provider/model-one', providerSessionId: 'shared-id' },
    undefined,
    true,
    'shared-id',
  )
  assert.equal(result, null)
  assert.equal(cliReads, 0)
  assert.deepEqual(urls, [])
})

test('compact usage requires an exact Magpie Agent/session match from Web API data', async () => {
  const paths: string[] = []
  let cliReads = 0
  const service = createWebUsageService({
    readModels: async () => { cliReads += 1; return null },
    fetch: (async (url) => {
      const target = new URL(String(url))
      paths.push(target.pathname)
      return target.pathname.endsWith('/quotas')
        ? Response.json([])
        : Response.json(usageReply([{ agent: 'codex', id: 'some-other-session', input: 1, output: 1, cost: 0 }]))
    }) as typeof fetch,
  })

  assert.equal(await service.read({ adapterId: 'claude-code', modelId: 'example-provider/not-listed', providerSessionId: 'agent-session-1' }, undefined, true), null)
  assert.equal(await service.read({ adapterId: 'other-agent', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true), null)
  assert.equal(await service.read({ adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true), null)
  assert.equal(cliReads, 0, 'usage reads never query the CLI model catalog')
  assert.equal(paths.filter(path => path === '/api/usage').length, 2)
  assert.equal(paths.some(path => path === '/api/usage/requests'), false, 'no request is made without a matching Agent/session aggregate')
})

test('aborting one compact usage read does not cancel a concurrent Web API read', async () => {
  const caller = new AbortController()
  let usageCalls = 0
  const service = createWebUsageService({
    fetch: (async (url, init) => {
      const target = new URL(String(url))
      if (target.pathname === '/api/usage/quotas') return Response.json([])
      if (target.pathname === '/api/usage') {
        usageCalls += 1
        if (usageCalls === 1) return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        })
        return Response.json(usageReply())
      }
      throw new Error(`unexpected Web API path ${target.pathname}`)
    }) as typeof fetch,
  })
  const session = { adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }
  const cancelledRead = service.read(session, caller.signal)
  const survivingRead = service.read(session, new AbortController().signal)
  await setImmediate()
  caller.abort()
  await assert.rejects(cancelledRead)
  assert.equal((await survivingRead)?.usageStatus, 'available')
  assert.equal(usageCalls, 2)
})

test('Web API request rows are exact-matched and failed reads do not leak raw errors', async () => {
  let routeRows: unknown[] = [{
    agent: 'claude', session: 'different-session', provider: 'private-provider', req: 'private',
  }]
  let usageStatus = 200
  let routeStatus = 200
  const service = createWebUsageService({
    fetch: (async (url) => {
      const target = new URL(String(url))
      if (target.pathname.endsWith('/usage/requests')) return Response.json({ rows: routeRows }, { status: routeStatus })
      if (target.pathname.endsWith('/quotas')) return Response.json([])
      return Response.json(usageStatus === 200 ? usageReply() : { error: 'do-not-forward-this-error' }, { status: usageStatus })
    }) as typeof fetch,
  })

  const mismatched = await service.read({ adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true)
  assert.equal(mismatched?.routeStatus, 'no-route')
  assert.equal(mismatched?.route, null)
  assert.doesNotMatch(JSON.stringify(mismatched), /different-session|private/u)

  routeRows = []
  const noRoute = await service.read({ adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true)
  assert.equal(noRoute?.routeStatus, 'no-route')

  routeStatus = 403
  const routeUnavailable = await service.read({ adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true)
  assert.equal(routeUnavailable?.routeStatus, 'unavailable')

  usageStatus = 403
  const unavailable = await service.read({ adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true)
  assert.equal(unavailable, null)
  assert.doesNotMatch(JSON.stringify(unavailable), /do-not-forward-this-error/u)
})

test('cancelling the Host request aborts the in-flight Magpie Web API ledger read', async () => {
  const controller = new AbortController()
  let routeSignal: AbortSignal | undefined
  let markRouteStarted!: () => void
  const routeStarted = new Promise<void>((resolve) => { markRouteStarted = resolve })
  const service = createWebUsageService({
    fetch: (async (url, init) => {
      if (!String(url).includes('/usage/requests')) return Response.json(usageReply())
      routeSignal = init?.signal ?? undefined
      markRouteStarted()
      return new Promise((_resolve, reject) => {
        routeSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }) as typeof fetch,
  })
  const request = service.read({ adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, controller.signal, true)
  await routeStarted
  controller.abort()
  await assert.rejects(request)
  assert.equal(routeSignal?.aborted, true)
})

test('Magpie Web API usage failures return no snapshot and never expose error content', async () => {
  const session = { adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }
  for (const response of [Response.json({ error: 'do-not-forward-this-error' }, { status: 403 }), new Response('not json')]) {
    const service = createWebUsageService({ fetch: (async (url) => String(url).endsWith('/api/usage/quotas') ? Response.json([]) : response) as typeof fetch })
    const result = await service.read(session)
    assert.equal(result, null)
    assert.doesNotMatch(JSON.stringify(result), /do-not-forward-this-error|not json/u)
  }
})

test('上游不提供账号名时保留该厂商的配额，而不是显示成"没有报告配额"', async () => {
  const sessionId = 'dsh-auto-gpt-6-1-sol'
  const modelOutput = [
    'Routing groups', 'auto/gpt-6.1-sol    GPT-6.1 Sol-Auto',
    "dsh is shown every provider's models · magpie visible dsh", 'http://127.0.0.1:3425/v1',
  ].join('\n')
  const service = createWebUsageService({
    readModels: async () => modelOutput,
    fetch: (async (url) => {
      const target = new URL(String(url))
      if (target.pathname.endsWith('/quotas')) return Response.json({ data: [
        // Codex 这类量贩账号没有 `user`：请求记录里的 providerAccount 永远对不上它。
        { provider: 'glorinfo-api-platform', name: 'GAP-Codex', user: null, windows: [{ name: '1 day', amount: 1, limit: 4, unit: 'USD' }] },
        { provider: 'grox-claude', name: 'Grox-Claude', user: null, windows: [{ name: '1 day', amount: 4, limit: 4, unit: 'USD' }] },
      ] })
      if (target.pathname.endsWith('/usage/requests')) return Response.json({ rows: [{
        route_id: 22, t: '2026-10-23T15:53:00Z', agent: 'dsh', session: sessionId,
        req: 'group/auto-gpt-6-1-sol', provider: 'glorinfo-api-platform', providerAccount: 'api-key',
        model: 'gpt-6.1-sol', served: 'gpt-6.1-sol', status: 200,
      }] })
      return Response.json(usageReply([{ agent: 'dsh', id: sessionId, input: 8, output: 2, cost: 0.001 }]))
    }) as typeof fetch,
  })

  const result = await service.read({ adapterId: 'dsh', modelId: 'auto/gpt-6.1-sol' }, undefined, true, sessionId)
  assert.deepEqual(result?.upstreamProviders, ['glorinfo-api-platform'])
  assert.equal(result?.quotaStatus, 'available')
  assert.deepEqual(result?.quotas.map((quota) => quota.provider), ['glorinfo-api-platform'], 'the routed provider keeps its own quota')
  assert.equal(result?.quotas[0]?.active, undefined, 'an unknown account name must never be marked as the active account')
})

test('活动账号按厂商判定，不同厂商的同名账号不会被误标', async () => {
  const sessionId = 'claude-shared-account-name'
  const service = createWebUsageService({
    readModels: async () => [
      'Routing groups', 'auto/deepseek-v4.1-flash    Deepseek-V4.1-Flash-Auto',
      "claude is shown every provider's models · magpie visible claude", 'http://127.0.0.1:3425/v1',
    ].join('\n'),
    fetch: (async (url) => {
      const target = new URL(String(url))
      if (target.pathname.endsWith('/quotas')) return Response.json({ data: [
        { provider: 'workbuddy', name: 'WorkBuddy', user: 'shared@example.com', windows: [{ name: 'Credits', remaining: 70 }] },
        { provider: 'workbuddy-ai', name: 'WorkBuddy AI', user: 'shared@example.com', windows: [{ name: 'Credits', remaining: 90 }] },
      ] })
      if (target.pathname.endsWith('/usage/requests')) return Response.json({ rows: [{
        route_id: 31, t: '2026-10-23T15:00:00Z', agent: 'claude', session: sessionId,
        req: 'group/auto-deepseek-v4-1-flash', provider: 'workbuddy', providerAccount: 'shared@example.com',
        model: 'deepseek-v4.1-flash', served: 'deepseek-v4.1-flash', status: 200,
      }] })
      return Response.json(usageReply([{ agent: 'claude', id: sessionId, input: 8, output: 2, cost: 0.001 }]))
    }) as typeof fetch,
  })

  const result = await service.read({ adapterId: 'claude-code', modelId: 'auto/deepseek-v4.1-flash[1m]', providerSessionId: sessionId }, undefined, true)
  const active = result?.quotas.filter((quota) => quota.active === true).map((quota) => quota.provider)
  assert.deepEqual(active, ['workbuddy'], 'only the routed provider owns the active account')
})

test('Magpie 自动模型在页面加载后主动解析上游配额并显示圆环', async (t) => {
  let component: ((props: unknown) => unknown) | undefined
  const slots = {
    inject: (_name: string, register: () => unknown) => register(),
    register: (_options: unknown, render: (props: unknown) => unknown) => { component = render; return () => undefined },
  }
  const subscriptionReads: boolean[] = []
  const rpc = {
    call: async (_channel: string, method: string, payload: unknown) => {
      if (method.endsWith('/session/get')) return {
        ok: true,
        value: { adapterId: 'claude-code', modelId: 'auto/deepseek-v4.1-flash', providerSessionId: 'magpie-session' },
      }
      assert.ok(method.endsWith('/subscription'))
      const includeRoute = (payload as { includeRoute?: boolean }).includeRoute === true
      subscriptionReads.push(includeRoute)
      return {
        ok: true,
        value: {
          providerUsage: null,
          magpie: {
            agent: 'claude', modelId: 'auto/deepseek-v4.1-flash', capturedAt: new Date().toISOString(), usageStatus: 'available',
            aggregate: { calls: 1, errors: 0, inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
            sessionId: 'magpie-session',
            session: { id: 'magpie-session', agent: 'claude', calls: 1, errors: 0, inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
            routeStatus: includeRoute ? 'available' : 'not-requested',
            route: includeRoute ? {
              asked: 'auto/deepseek-v4.1-flash', group: null, rule: null, model: 'workbuddy/deepseek-v4.1-flash', effort: null,
              tries: [], done: true, status: '200', served: 'deepseek-v4.1-flash',
            } : null,
            upstreamProvider: includeRoute ? 'workbuddy' : null,
            upstreamProviders: includeRoute ? ['workbuddy'] : [],
            quotaStatus: includeRoute ? 'available' : 'provider-unavailable',
            quotas: includeRoute ? [{
              provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', user: null, plan: null, alias: null, balance: null, readAt: null,
              windows: [{ name: 'Credits', usedPercent: 27, remainingPercent: 73, resetsAt: null, display: null, amount: null, limit: null, unit: null, holdsWhy: null }],
            }] : [],
          },
        },
      }
    },
  }
  registerSubscriptionSlot(slots as never, rpc as never)
  assert.ok(component)
  const view = createHookRenderer(component!, { rpc, sessionId: 'dsh-session' })
  t.after(() => view.dispose())

  const findTrigger = (node: unknown): { readonly children: unknown } | null => {
    if (Array.isArray(node)) return node.map(findTrigger).find((item) => item !== null) ?? null
    if (node === null || typeof node !== 'object') return null
    const element = node as { readonly type?: unknown; readonly props?: { readonly className?: unknown; readonly children?: unknown } }
    if (element.type === 'button' && element.props?.className === 'codingns4dsh-subscription-trigger') return { children: element.props.children }
    return findTrigger(element.props?.children)
  }

  let trigger: ReturnType<typeof findTrigger> = null
  for (let attempt = 0; attempt < 12; attempt++) {
    await setImmediate()
    trigger = findTrigger(view.render())
    if (subscriptionReads.includes(true) && trigger !== null) break
  }
  assert.deepEqual(subscriptionReads, [false, true], 'the initial unknown-provider snapshot should trigger one route-aware refresh')
  assert.ok(trigger)
  assert.match(JSON.stringify(trigger.children), /conic-gradient/u)
  assert.match(JSON.stringify(trigger.children), /73/u)
  assert.doesNotMatch(JSON.stringify(trigger.children), /Magpie/u)
})

test('关闭 Magpie 用量弹层会取消当前路由读取', async (t) => {
  const claudeModelId = 'auto/deepseek-v4.1-flash[1m]'
  const routedModel = 'sub2api/deepseek-v4.1-flash'
  let component: ((props: unknown) => unknown) | undefined
  const slots = {
    inject: (_name: string, register: () => unknown) => register(),
    register: (_options: unknown, render: (props: unknown) => unknown) => { component = render; return () => undefined },
  }
  let routeSignal: AbortSignal | undefined
  let routeAborts = 0
  const rpc = {
    call: async (_channel: string, method: string, payload: unknown, signal?: AbortSignal) => {
      if (method.endsWith('/session/get')) return { ok: true, value: { adapterId: 'claude-code', modelId: claudeModelId, providerSessionId: 'agent-session-1' } }
      assert.ok(method.endsWith('/subscription'))
      assert.equal((payload as { modelId?: string }).modelId, claudeModelId)
      if ((payload as { includeRoute?: boolean }).includeRoute !== true) {
        return { ok: true, value: { providerUsage: null, magpie: {
          agent: 'claude', modelId: claudeModelId, capturedAt: new Date().toISOString(), usageStatus: 'available',
          aggregate: { calls: 3, errors: 0, inputTokens: 300, outputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0, costUsd: 0.01 },
          sessionId: 'agent-session-1',
          session: { id: 'agent-session-1', agent: 'claude', calls: 1, errors: 0, inputTokens: 100, outputTokens: 50, cacheReadTokens: 25, cacheWriteTokens: 0, costUsd: 0.005 },
          routeStatus: 'available',
          route: { asked: 'group/auto-deepseek-v4-1-flash', group: 'auto-deepseek-v4-1-flash', rule: null, model: routedModel, effort: 'high', tries: [], done: false, status: '200', served: 'deepseek-v4.1-flash' },
          upstreamProvider: 'sub2api', upstreamProviders: ['sub2api'], quotaStatus: 'available', quotas: [{
            provider: 'sub2api', name: 'Sub2API', kind: 'subscription', user: 'Primary account', plan: 'Plus', alias: 'DeepSeek', balance: null, readAt: null,
            windows: [{ name: '7 days', usedPercent: 12, remainingPercent: 88, resetsAt: '2026-10-28T08:00:00Z', display: '12 / 100', amount: 12, limit: 100, unit: 'credits', holdsWhy: null }],
          }],
        } } }
      }
      routeSignal = signal
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => { routeAborts++; reject(new Error('request aborted')) }, { once: true })
      })
    },
  }
  registerSubscriptionSlot(slots as never, rpc as never)
  assert.ok(component)
  const view = createHookRenderer(component!, { rpc, sessionId: 'dsh-session-1' })
  t.after(() => view.dispose())

  const flush = async (): Promise<void> => {
    for (let attempt = 0; attempt < 8; attempt++) {
      await setImmediate()
      view.render()
      if (routeSignal !== undefined) return
    }
  }
  const findTrigger = (node: unknown): { readonly props: { readonly onClick: () => void } } | null => {
    if (Array.isArray(node)) return node.map(findTrigger).find((item) => item !== null) ?? null
    if (node === null || typeof node !== 'object') return null
    const element = node as { readonly type?: unknown; readonly props?: { readonly className?: unknown; readonly children?: unknown; readonly onClick?: unknown } }
    if (element.type === 'button' && element.props?.className === 'codingns4dsh-subscription-trigger' && typeof element.props.onClick === 'function') return { props: element.props as { readonly onClick: () => void } }
    return findTrigger(element.props?.children)
  }

  view.render()
  await flush()
  const trigger = findTrigger(view.render())
  assert.ok(trigger, 'Magpie usage trigger should render')
  assert.match(JSON.stringify(trigger.props.children), /conic-gradient/u, 'available Magpie quota should use the subscription ring')
  assert.match(JSON.stringify(trigger.props.children), /88/u, 'the ring should display the remaining upstream percentage')
  assert.doesNotMatch(JSON.stringify(trigger.props.children), /Magpie/u, 'the quota ring should replace the Magpie label')
  trigger.props.onClick()
  const panel = view.render()
  assert.match(JSON.stringify(panel), /auto\/deepseek-v4\.1-flash\[1m\]/u)
  assert.match(JSON.stringify(panel), /agent-session-1/u)
  assert.match(JSON.stringify(panel), /api\/codingns\/provider-icons\/magpie\.png/u)
  const children = (panel as { readonly props: { readonly children: readonly unknown[] } }).props.children
  const popover = children.find((child) => typeof child === 'object' && child !== null
    && typeof (child as { readonly type?: unknown }).type === 'function') as { readonly type: (props: never) => unknown; readonly props: unknown } | undefined
  assert.ok(popover, 'Magpie popover should render its content component')
  const content = JSON.stringify(popover.type(popover.props as never))
  assert.match(content, /网关用量/u)
  assert.match(content, /当前 Agent 会话/u)
  assert.match(content, /缓存读取/u)
  assert.match(content, /更新于/u)
  assert.match(content, /"width":400/u, 'Magpie should open at the wider panel size')
  assert.match(content, /"padding":12/u, 'all four popover padding sides should be 12px')
  assert.doesNotMatch(content, /auto\/deepseek-v4\.1-flash\[1m\]/u, 'the model ID is omitted from the header')
  assert.doesNotMatch(content, /今日 · 所有 Magpie Agent/u, 'the all-agent scope label is omitted from the header')
  assert.match(content, /"gridTemplateColumns":"repeat\(3,/u, 'usage metrics should use a three-column grid')
  assert.equal((content.match(/"minHeight":40/gu) ?? []).length, 18, 'gateway and session usage should each contain nine scaled metric cells')
  assert.match(content, /缓存命中率/u)
  assert.match(content, /6\.3%/u)
  assert.match(content, /20\.0%/u)
  assert.ok(content.indexOf('缓存命中率') < content.indexOf('预估费用'), 'cache hit rate should appear to the left of estimated cost')
  const findRouteTab = (node: unknown): { readonly props: { readonly onClick: () => void } } | null => {
    if (Array.isArray(node)) return node.map(findRouteTab).find((item) => item !== null) ?? null
    if (node === null || typeof node !== 'object') return null
    const element = node as { readonly type?: unknown; readonly props?: { readonly id?: unknown; readonly children?: unknown; readonly onClick?: unknown } }
    if (element.type === 'button' && element.props?.id === 'codingns4dsh-magpie-tab-route' && typeof element.props.onClick === 'function') {
      return { props: { onClick: element.props.onClick as () => void } }
    }
    return findRouteTab(element.props?.children)
  }
  const routeTab = findRouteTab(popover.type(popover.props as never))
  assert.ok(routeTab, 'routing should have its own tab')
  routeTab.props.onClick()
  const routePanelView = view.render()
  const routeChildren = (routePanelView as { readonly props: { readonly children: readonly unknown[] } }).props.children
  const routePopover = routeChildren.find((child) => typeof child === 'object' && child !== null
    && typeof (child as { readonly type?: unknown }).type === 'function') as { readonly type: (props: never) => unknown; readonly props: unknown } | undefined
  assert.ok(routePopover)
  const routeContent = JSON.stringify(routePopover.type(routePopover.props as never))
  assert.match(routeContent, /codingns4dsh-magpie-panel-route/u)
  assert.match(routeContent, /codingns4dsh-magpie-route-node-active/u)
  assert.match(routeContent, /sub2api\/deepseek-v4\.1-flash/u)
  assert.match(routeContent, /请求的模型/u)
  assert.match(routeContent, /当前目标/u)
  assert.match(routeContent, /实际响应模型/u)
  assert.match(routeContent, /gridTemplateColumns/u, 'route stages should use a vertically stacked, wrapping layout')
  assert.match(routeContent, /"height":28/u, 'vertical connectors should scale with the route stages')
  assert.doesNotMatch(routeContent, /codingns4dsh-magpie-tab-quota/u, 'quota and routing should share one tab')
  assert.match(routeContent, /Primary account/u)
  assert.match(routeContent, /88%/u)
  assert.match(routeContent, /12 \/ 100/u)
  await flush()
  assert.ok(routeSignal, 'opening the panel should start a route-aware read')
  assert.equal(routeSignal.aborted, false)

  const openTrigger = findTrigger(view.render())
  assert.ok(openTrigger)
  openTrigger.props.onClick()
  view.render()
  await setImmediate()
  assert.equal(routeSignal.aborted, true)
  assert.equal(routeAborts, 1)
  for (let attempt = 0; attempt < 8; attempt++) {
    await setImmediate()
    view.render()
  }
  assert.ok(findTrigger(view.render()), 'cancelling route refresh must not hide the usage trigger')
})

test('Agent 会话绑定更新后不会继续显示绑定前缓存的 Magpie 会话', async (t) => {
  let component: ((props: unknown) => unknown) | undefined
  const slots = {
    inject: (_name: string, register: () => unknown) => register(),
    register: (_options: unknown, render: (props: unknown) => unknown) => { component = render; return () => undefined },
  }
  let providerSessionId: string | undefined
  let subscriptionReads = 0
  const rpc = {
    call: async (_channel: string, method: string, payload: unknown) => {
      if (method.endsWith('/session/get')) return {
        ok: true,
        value: {
          adapterId: 'claude-code',
          modelId: 'example-provider/model-one',
          ...(providerSessionId === undefined ? {} : { providerSessionId }),
        },
      }
      assert.ok(method.endsWith('/subscription'))
      subscriptionReads += 1
      const sessionId = providerSessionId ?? null
      return {
        ok: true,
        value: {
          providerUsage: null,
          magpie: {
            agent: 'claude', modelId: 'example-provider/model-one', capturedAt: new Date().toISOString(), usageStatus: 'available',
            aggregate: { calls: 3, errors: 0, inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
            sessionId,
            session: sessionId === null ? null : {
              id: sessionId, agent: 'claude', calls: 1, errors: 0, inputTokens: 100, outputTokens: 50,
              cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.005,
            },
            routeStatus: (payload as { includeRoute?: boolean }).includeRoute ? 'unavailable' : 'not-requested', route: null,
          },
        },
      }
    },
  }
  registerSubscriptionSlot(slots as never, rpc as never)
  assert.ok(component)
  const props = (running: boolean) => ({
    rpc,
    sessionId: 'dsh-session-1',
    useSession: (selector: (session: { readonly modelSelection: unknown; readonly running: boolean }) => unknown) => selector({ modelSelection: { modelId: 'example-provider/model-one' }, running }),
  })
  const view = createHookRenderer(component!, props(false) as never)
  t.after(() => view.dispose())

  const flushReads = async (expected: number): Promise<void> => {
    for (let attempt = 0; attempt < 12 && subscriptionReads < expected; attempt++) {
      await setImmediate()
      view.render()
    }
  }
  view.render()
  await flushReads(1)
  assert.equal(subscriptionReads, 1)

  view.render(props(true) as never)
  providerSessionId = 'agent-session-after-binding'
  view.render(props(false) as never)
  await flushReads(2)
  assert.equal(subscriptionReads, 2, 'binding a native Agent session must cause a fresh usage read')
  const findTrigger = (node: unknown): { readonly onClick: () => void } | null => {
    if (Array.isArray(node)) return node.map(findTrigger).find((item) => item !== null) ?? null
    if (node === null || typeof node !== 'object') return null
    const element = node as { readonly type?: unknown; readonly props?: { readonly className?: unknown; readonly children?: unknown; readonly onClick?: unknown } }
    if (element.type === 'button' && element.props?.className === 'codingns4dsh-subscription-trigger' && typeof element.props.onClick === 'function') {
      return { onClick: element.props.onClick as () => void }
    }
    return findTrigger(element.props?.children)
  }
  const trigger = findTrigger(view.render())
  assert.ok(trigger)
  trigger.onClick()
  assert.match(JSON.stringify(view.render()), /agent-session-after-binding/u)
})

test('旧版 Host 返回的普通订阅数据仍显示原用量入口', async (t) => {
  let component: ((props: unknown) => unknown) | undefined
  const slots = {
    inject: (_name: string, register: () => unknown) => register(),
    register: (_options: unknown, render: (props: unknown) => unknown) => { component = render; return () => undefined },
  }
  const rpc = {
    call: async (_channel: string, method: string) => method.endsWith('/session/get')
      ? { ok: true, value: { adapterId: 'claude-code', modelId: 'ordinary-model' } }
      : { ok: true, value: { primary: { remainingPercent: 42, resetsAt: null }, secondary: null, monthly: null } },
  }
  registerSubscriptionSlot(slots as never, rpc as never)
  assert.ok(component)
  const view = createHookRenderer(component!, { rpc, sessionId: 'ordinary-session' })
  t.after(() => view.dispose())
  const findTrigger = (node: unknown): { readonly props: { readonly children: unknown } } | null => {
    if (Array.isArray(node)) return node.map(findTrigger).find((item) => item !== null) ?? null
    if (node === null || typeof node !== 'object') return null
    const element = node as { readonly type?: unknown; readonly props?: { readonly className?: unknown; readonly children?: unknown } }
    if (element.type === 'button' && element.props?.className === 'codingns4dsh-subscription-trigger') return { props: { children: element.props.children } }
    return findTrigger(element.props?.children)
  }
  const readText = (node: unknown): string => {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(readText).join(' ')
    if (node === null || typeof node !== 'object') return ''
    return readText((node as { readonly props?: { readonly children?: unknown } }).props?.children)
  }
  let output: unknown
  let trigger: ReturnType<typeof findTrigger> = null
  for (let attempt = 0; attempt < 8 && trigger === null; attempt++) {
    await setImmediate()
    output = view.render()
    trigger = findTrigger(output)
  }
  assert.ok(trigger, 'ordinary subscription trigger should remain visible')
  assert.match(readText(trigger.props.children), /42/u)
  assert.doesNotMatch(readText(output), /Magpie/u)
})

test('Magpie 模型已确认但网关不可用时不回退显示 Command Code 订阅卡', async (t) => {
  let component: ((props: unknown) => unknown) | undefined
  const slots = {
    inject: (_name: string, register: () => unknown) => register(),
    register: (_options: unknown, render: (props: unknown) => unknown) => { component = render; return () => undefined },
  }
  const rpc = {
    call: async (_channel: string, method: string) => method.endsWith('/session/get')
      ? { ok: true, value: { adapterId: 'command-code', modelId: 'magpie/example-provider/model-one' } }
      : {
          ok: true,
          value: {
            providerUsage: { primary: { remainingPercent: 42, resetsAt: null }, secondary: null, monthly: null },
            magpie: {
              agent: 'commandcode', modelId: 'magpie/example-provider/model-one', capturedAt: new Date().toISOString(), usageStatus: 'unavailable',
              aggregate: null, sessionId: null, session: null, routeStatus: 'session-unavailable', route: null,
            },
          },
        },
  }
  registerSubscriptionSlot(slots as never, rpc as never)
  assert.ok(component)
  const view = createHookRenderer(component!, { rpc, sessionId: 'command-code-magpie-session' })
  t.after(() => view.dispose())

  const findTrigger = (node: unknown): { readonly onClick: () => void } | null => {
    if (Array.isArray(node)) return node.map(findTrigger).find((item) => item !== null) ?? null
    if (node === null || typeof node !== 'object') return null
    const element = node as { readonly type?: unknown; readonly props?: { readonly className?: unknown; readonly children?: unknown; readonly onClick?: unknown } }
    if (element.type === 'button' && element.props?.className === 'codingns4dsh-subscription-trigger' && typeof element.props.onClick === 'function') {
      return { onClick: element.props.onClick as () => void }
    }
    return findTrigger(element.props?.children)
  }
  let output: unknown
  let trigger: ReturnType<typeof findTrigger> = null
  for (let attempt = 0; attempt < 8 && trigger === null; attempt++) {
    await setImmediate()
    output = view.render()
    trigger = findTrigger(output)
  }
  assert.ok(trigger)
  assert.match(JSON.stringify(output), /Magpie/u)
  assert.doesNotMatch(JSON.stringify(output), /42/u)
  trigger.onClick()
  const panel = view.render()
  const children = (panel as { readonly props: { readonly children: readonly unknown[] } }).props.children
  const popover = children.find((child) => typeof child === 'object' && child !== null
    && typeof (child as { readonly type?: unknown }).type === 'function') as { readonly type: (props: never) => unknown; readonly props: unknown } | undefined
  assert.ok(popover, 'Magpie popover should render its content component')
  assert.match(JSON.stringify(popover.type(popover.props as never)), /暂时无法读取 Magpie 用量/u)
})
