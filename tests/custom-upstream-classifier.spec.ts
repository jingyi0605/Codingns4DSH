import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CustomUpstreamClassifier,
  mergeCustomUpstreamCandidates,
  type CustomUpstreamSource,
} from '../data/build/dist/host/cli-adapters/custom-upstream-classifier.js'
import type { CliSubscriptionUsage } from '../data/build/dist/shared/contracts/subscription.js'

function usage(): CliSubscriptionUsage {
  return {
    authenticated: true,
    planType: null,
    primary: null,
    secondary: null,
    monthly: null,
    rateLimitReachedType: null,
    resetCredits: null,
    capturedAt: new Date().toISOString(),
  }
}

function source(baseUrl = 'https://upstream.example.test/v1', apiKey = 'secret'): CustomUpstreamSource {
  return { baseUrl, apiKey }
}

test('统一分类器识别 New-API，并把分类结果与余额读取分开缓存', async () => {
  const classifier = new CustomUpstreamClassifier()
  let newApiCalls = 0
  let sub2apiCalls = 0
  const result = await classifier.read('command-code', undefined, [{ source: source(), newApi: true, sub2api: true }], {
    newApi: async () => {
      newApiCalls += 1
      return { usage: usage(), kind: 'new-api' }
    },
    sub2api: async () => {
      sub2apiCalls += 1
      return null
    },
  })
  assert.equal(result?.classification.kind, 'new-api')
  assert.equal(result?.classification.reader, 'new-api')
  assert.equal(result?.classification.confidence, 'strong')
  assert.equal(newApiCalls, 1)
  assert.equal(sub2apiCalls, 1)

  const refreshed = await classifier.read('command-code', undefined, [{ source: source(), newApi: true, sub2api: true }], {
    newApi: async () => {
      newApiCalls += 1
      return { usage: usage(), kind: 'new-api' }
    },
    sub2api: async () => {
      sub2apiCalls += 1
      return { usage: usage(), kind: 'sub2api' }
    },
  })
  assert.equal(refreshed?.classification.kind, 'new-api')
  assert.equal(newApiCalls, 2)
  assert.equal(sub2apiCalls, 1)
})

test('统一分类器识别 Sub2API，并保留读取器提供的按日按模型数据', async () => {
  const classifier = new CustomUpstreamClassifier()
  const result = await classifier.read('zcode', undefined, [{ source: source(), newApi: true, sub2api: true }], {
    newApi: async () => null,
    sub2api: async () => ({ usage: usage(), kind: 'sub2api' }),
  })
  assert.equal(result?.classification.kind, 'sub2api')
  assert.equal(result?.classification.reader, 'sub2api')
  assert.ok(result?.usage)
})

test('只有 billing 接口命中时标记为弱 New-API 兼容结果', async () => {
  const classifier = new CustomUpstreamClassifier()
  const result = await classifier.read('opencode', undefined, [{ source: source(), newApi: true, sub2api: true }], {
    newApi: async () => ({ usage: usage(), kind: 'new-api-billing-compatible' }),
    sub2api: async () => null,
  })
  assert.equal(result?.classification.kind, 'new-api-billing-compatible')
  assert.equal(result?.classification.confidence, 'weak')
  assert.equal(result?.classification.reader, 'new-api')
})

test('完整 Sub2API 命中时覆盖弱 New-API billing 兼容结果', async () => {
  const classifier = new CustomUpstreamClassifier()
  const result = await classifier.read('opencode', undefined, [{ source: source(), newApi: true, sub2api: true }], {
    newApi: async () => ({ usage: usage(), kind: 'new-api-billing-compatible' }),
    sub2api: async () => ({ usage: usage(), kind: 'sub2api' }),
  })
  assert.equal(result?.classification.kind, 'sub2api')
  assert.equal(result?.classification.reader, 'sub2api')
  assert.equal(result?.classification.confidence, 'strong')
  assert.ok(result?.usage)
})

test('两个协议都命中时返回 ambiguous，不静默套用任一协议', async () => {
  const classifier = new CustomUpstreamClassifier()
  const result = await classifier.read('codebuddy', 'provider-a', [{ source: source(), newApi: true, sub2api: true }], {
    newApi: async () => ({ usage: usage(), kind: 'new-api' }),
    sub2api: async () => ({ usage: usage(), kind: 'sub2api' }),
  })
  assert.equal(result?.classification.kind, 'ambiguous')
  assert.equal(result?.classification.reader, null)
  assert.equal(result?.usage, null)
})

test('普通 balance/remaining 响应不会被伪装成 New-API 或 Sub2API', async () => {
  const classifier = new CustomUpstreamClassifier()
  const result = await classifier.read('codex', undefined, [{ source: source(), newApi: true, sub2api: true }], {
    newApi: async () => null,
    sub2api: async () => null,
  })
  assert.equal(result?.classification.kind, 'unknown')
  assert.equal(result?.usage, null)
})

test('已分类为 New-API 后临时失败不会切换到 Sub2API', async () => {
  const classifier = new CustomUpstreamClassifier()
  let shouldFail = false
  const candidate = { source: source(), newApi: true, sub2api: true }
  const readers = {
    newApi: async () => shouldFail ? null : { usage: usage(), kind: 'new-api' as const },
    sub2api: async () => shouldFail ? { usage: usage(), kind: 'sub2api' as const } : null,
  }
  const first = await classifier.read('codex', undefined, [candidate], readers)
  assert.equal(first?.classification.kind, 'new-api')
  shouldFail = true
  const second = await classifier.read('codex', undefined, [candidate], readers)
  assert.equal(second?.classification.kind, 'new-api')
  assert.equal(second?.classification.reader, 'new-api')
  assert.equal(second?.usage, null)
})

test('来源合并按归一化 URL 和 API Key 指纹去重，并隔离不同凭据', () => {
  const merged = mergeCustomUpstreamCandidates(
    [source('https://upstream.example.test/v1?x=1', 'same-key')],
    [source('https://upstream.example.test/', 'same-key'), source('https://upstream.example.test', 'other-key')],
  )
  assert.equal(merged.length, 2)
  assert.equal(merged[0]?.newApi, true)
  assert.equal(merged[0]?.sub2api, true)
  assert.equal(merged[1]?.newApi, false)
  assert.equal(merged[1]?.sub2api, true)
})
