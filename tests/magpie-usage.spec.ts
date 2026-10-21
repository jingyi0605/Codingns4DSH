import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { MagpieUsageService, magpieAgentForAdapter, parseMagpieCliVersion, parseMagpieModelMetadata, parseMagpieModelOutput } from '../src/host/cli-adapters/magpie-usage.js'
import { registerSubscriptionSlot } from '../src/client/subscription-slot.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const usageReply = (sessions: unknown[] = [{
  agent: 'claude', id: 'agent-session-1', input: 120, output: 30,
  cache_read: 12, cache_write: 4, cost: 0.0125,
}]) => ({
  calls: 3, errors: 1, input: 300, output: 90, cache_read: 20, cache_write: 8, cost: 0.0325,
  sessions,
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
    "claude is shown every provider's models · magpie visible claude",
    'http://127.0.0.1:3425/v1',
  ].join('\n'), 'claude')
  assert.ok(catalog)
  assert.equal(catalog.names.has('shared label'), false, 'ambiguous labels must not select a provider')
  assert.equal(catalog.names.get('unique label'), 'provider/three')
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

test('DSH、OpenCode 和全部外部 Agent 适配器按目录确认 Magpie Agent 身份', async () => {
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
    const output = [
      'Example provider',
      'example-provider/model-one    Model One',
      `${expectedAgent} is shown every provider's models · magpie visible ${expectedAgent}`,
      'http://127.0.0.1:3425/v1',
    ].join('\n')
    const service = new MagpieUsageService({
      readModels: async (agent) => {
        assert.equal(agent, expectedAgent)
        return output
      },
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

test('Magpie API 只在目录精确命中后读取，并把汇总、当前会话和路由分开', async () => {
  const modelOutput = await fixture('magpie-models-claude.txt')
  const calls: Array<{ url: string; authorization: string | null }> = []
  const service = new MagpieUsageService({
    readModels: async () => modelOutput,
    now: () => Date.parse('2026-10-20T12:00:00.000Z'),
    fetch: (async (url, init) => {
      calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') })
      if (String(url).includes('/route?')) {
        return Response.json({
          session: 'agent-session-1', seq: 7,
          route: {
            asked: 'example-provider/model-one', group: 'balanced', rule: { name: 'primary' },
            model: 'example-provider/model-one', effort: 'high', done: true, status: 200,
            served: 'example-provider/model-one', tries: [{ model: 'example-provider/model-one', done: true }],
          },
        })
      }
      return Response.json(usageReply())
    }) as typeof fetch,
  })

  const result = await service.read({ adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true)
  assert.deepEqual(calls.map((call) => call.url), [
    'http://127.0.0.1:3425/v1/magpie/usage?period=today',
    'http://127.0.0.1:3425/v1/magpie/route?session=agent-session-1',
  ])
  assert.ok(calls.every((call) => call.authorization === 'Bearer magpie'))
  assert.equal(result?.usageStatus, 'available')
  assert.deepEqual(result?.aggregate, { calls: 3, errors: 1, inputTokens: 300, outputTokens: 90, cacheReadTokens: 20, cacheWriteTokens: 8, costUsd: 0.0325 })
  assert.deepEqual(result?.session, { id: 'agent-session-1', agent: 'claude', calls: null, errors: null, inputTokens: 120, outputTokens: 30, cacheReadTokens: 12, cacheWriteTokens: 4, costUsd: 0.0125 })
  assert.equal(result?.routeStatus, 'available')
  assert.equal(result?.route?.rule, 'primary')
  assert.equal(result?.route?.tries[0]?.failed, false)
  assert.doesNotMatch(JSON.stringify(result), /Bearer|Authorization|prompt|response body/u)
})

test('Codex 仅使用 Codex 目录与精确匹配的 Codex 会话', async () => {
  const modelOutput = await fixture('magpie-models-codex.txt')
  const agents: string[] = []
  const urls: string[] = []
  const service = new MagpieUsageService({
    readModels: async (agent) => { agents.push(agent); return modelOutput },
    fetch: (async (url) => {
      urls.push(String(url))
      return Response.json(usageReply([{ agent: 'codex', id: 'codex-thread-7', input: 8, output: 2, cost: 0.001 }]))
    }) as typeof fetch,
  })
  const result = await service.read({ adapterId: 'codex', modelId: 'example-provider/model-one', providerSessionId: 'codex-thread-7' })
  assert.deepEqual(agents, ['codex'])
  assert.deepEqual(urls, ['http://127.0.0.1:3425/v1/magpie/usage?period=today'])
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
  const service = new MagpieUsageService({
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

test('Magpie 不把与 DSH 会话 ID 相同的回退值当作 Agent 会话', async () => {
  const modelOutput = await fixture('magpie-models-codex.txt')
  const urls: string[] = []
  const service = new MagpieUsageService({
    readModels: async () => modelOutput,
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
  assert.equal(result?.sessionId, null)
  assert.equal(result?.session, null)
  assert.equal(result?.routeStatus, 'session-unavailable')
  assert.deepEqual(urls, ['http://127.0.0.1:3425/v1/magpie/usage?period=today'])
})

test('非 Magpie 模型、其他适配器和未匹配的 Agent 会话都不会查询路由', async () => {
  const modelOutput = await fixture('magpie-models-claude.txt')
  let requests = 0
  let listed: string[] = []
  const service = new MagpieUsageService({
    readModels: async (agent) => { listed.push(agent); return modelOutput },
    fetch: (async () => { requests++; return Response.json(usageReply([{ agent: 'codex', id: 'some-other-session', input: 1, output: 1, cost: 0 }])) }) as typeof fetch,
  })

  assert.equal(await service.read({ adapterId: 'claude-code', modelId: 'example-provider/not-listed', providerSessionId: 'agent-session-1' }, undefined, true), null)
  assert.equal(await service.read({ adapterId: 'other-agent', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true), null)
  const unmatched = await service.read({ adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true)
  assert.deepEqual(listed, ['claude'])
  assert.equal(requests, 1, 'only the verified catalog model should reach the Gateway')
  assert.equal(unmatched?.usageStatus, 'available')
  assert.equal(unmatched?.session, null)
  assert.equal(unmatched?.routeStatus, 'unavailable')
})

test('一个订阅请求取消时不会取消同一 Agent 的共享目录读取', async () => {
  const modelOutput = await fixture('magpie-models-claude.txt')
  const lifetime = new AbortController()
  const caller = new AbortController()
  let releaseModels!: (value: string) => void
  let modelCalls = 0
  const modelRead = new Promise<string>((resolve) => { releaseModels = resolve })
  const service = new MagpieUsageService({
    lifetimeSignal: lifetime.signal,
    readModels: async (_agent, signal) => { modelCalls++; assert.equal(signal, lifetime.signal); return modelRead },
    fetch: (async () => Response.json(usageReply())) as typeof fetch,
  })
  const session = { adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }
  const cancelledRead = service.read(session, caller.signal)
  const survivingRead = service.read(session, new AbortController().signal)
  await setImmediate()
  caller.abort()
  await assert.rejects(cancelledRead)
  releaseModels(modelOutput)
  assert.equal((await survivingRead)?.usageStatus, 'available')
  assert.equal(modelCalls, 1)
})

test('路由响应必须回显同一个会话，HTTP 错误或用量 API 不可用时不泄漏原始错误', async () => {
  const modelOutput = await fixture('magpie-models-claude.txt')
  let routeResponse: Response = Response.json({ session: 'different-session', route: { asked: 'private' } })
  let usageStatus = 200
  const service = new MagpieUsageService({
    readModels: async () => modelOutput,
    fetch: (async (url) => String(url).includes('/route?')
      ? routeResponse
      : Response.json(usageStatus === 200 ? usageReply() : { error: 'do-not-forward-this-error' }, { status: usageStatus })) as typeof fetch,
  })

  const mismatched = await service.read({ adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true)
  assert.equal(mismatched?.routeStatus, 'unavailable')
  assert.equal(mismatched?.route, null)
  assert.doesNotMatch(JSON.stringify(mismatched), /different-session|private/u)

  routeResponse = Response.json({ session: 'agent-session-1', route: null })
  const noRoute = await service.read({ adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true)
  assert.equal(noRoute?.routeStatus, 'no-route')

  usageStatus = 403
  const unavailable = await service.read({ adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }, undefined, true)
  assert.equal(unavailable?.usageStatus, 'unavailable')
  assert.doesNotMatch(JSON.stringify(unavailable), /do-not-forward-this-error/u)
})

test('取消 Host 请求会中止正在等待的 Magpie 路由读取', async () => {
  const modelOutput = await fixture('magpie-models-claude.txt')
  const controller = new AbortController()
  let routeSignal: AbortSignal | undefined
  let markRouteStarted!: () => void
  const routeStarted = new Promise<void>((resolve) => { markRouteStarted = resolve })
  const service = new MagpieUsageService({
    readModels: async () => modelOutput,
    fetch: (async (url, init) => {
      if (!String(url).includes('/route?')) return Response.json(usageReply())
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
  const result = await request
  assert.equal(routeSignal?.aborted, true)
  assert.equal(result?.routeStatus, 'unavailable')
})

test('网关超时、无效 JSON 和超大响应均按不可用处理', async () => {
  const modelOutput = await fixture('magpie-models-claude.txt')
  const timeoutService = new MagpieUsageService({
    readModels: async () => modelOutput,
    timeoutMs: 5,
    fetch: (async (_url, init) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(usageReply())), 25)
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('local gateway timeout')) }, { once: true })
    })) as typeof fetch,
  })
  const session = { adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' }
  assert.equal((await timeoutService.read(session))?.usageStatus, 'unavailable')

  for (const response of [
    new Response('not json'),
    new Response(' '.repeat(2 * 1024 * 1024 + 1)),
  ]) {
    const service = new MagpieUsageService({ readModels: async () => modelOutput, fetch: (async () => response) as typeof fetch })
    assert.equal((await service.read(session))?.usageStatus, 'unavailable')
  }
})

test('关闭 Magpie 用量弹层会取消当前路由读取', async (t) => {
  let component: ((props: unknown) => unknown) | undefined
  const slots = {
    inject: (_name: string, register: () => unknown) => register(),
    register: (_options: unknown, render: (props: unknown) => unknown) => { component = render; return () => undefined },
  }
  let routeSignal: AbortSignal | undefined
  let routeAborts = 0
  const rpc = {
    call: async (_channel: string, method: string, payload: unknown, signal?: AbortSignal) => {
      if (method.endsWith('/session/get')) return { ok: true, value: { adapterId: 'claude-code', modelId: 'example-provider/model-one', providerSessionId: 'agent-session-1' } }
      assert.ok(method.endsWith('/subscription'))
      if ((payload as { includeRoute?: boolean }).includeRoute !== true) {
        return { ok: true, value: { providerUsage: null, magpie: {
          agent: 'claude', modelId: 'example-provider/model-one', capturedAt: new Date().toISOString(), usageStatus: 'available',
          aggregate: { calls: 3, errors: 0, inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
          sessionId: 'agent-session-1',
          session: { id: 'agent-session-1', agent: 'claude', calls: 1, errors: 0, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.005 },
          routeStatus: 'not-requested', route: null,
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
  trigger.props.onClick()
  const panel = view.render()
  assert.match(JSON.stringify(panel), /example-provider\/model-one/u)
  assert.match(JSON.stringify(panel), /agent-session-1/u)
  const children = (panel as { readonly props: { readonly children: readonly unknown[] } }).props.children
  const popover = children.find((child) => typeof child === 'object' && child !== null
    && typeof (child as { readonly type?: unknown }).type === 'function') as { readonly type: (props: never) => unknown; readonly props: unknown } | undefined
  assert.ok(popover, 'Magpie popover should render its content component')
  const content = JSON.stringify(popover.type(popover.props as never))
  assert.match(content, /网关用量/u)
  assert.match(content, /当前 Agent 会话/u)
  assert.match(content, /缓存读取/u)
  assert.match(content, /更新于/u)
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
