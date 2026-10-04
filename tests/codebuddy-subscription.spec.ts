import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodeBuddySubscriptionService } from '../data/build/dist/host/cli-adapters/codebuddy-subscription.js'
import { ProviderSubscriptionService } from '../data/build/dist/host/cli-adapters/provider-subscription.js'

function writeAuth(domain: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'codingns-codebuddy-subscription-'))
  const path = join(directory, 'auth.json')
  writeFileSync(path, JSON.stringify({
    account: { uid: 'cn-user-1' },
    auth: { domain, accessToken: 'secret-token' },
  }), 'utf8')
  return path
}

test('CodeBuddy 自动识别 CN 并读取 summary 与免费/付费套餐', async () => {
  const authFile = writeAuth('www.codebuddy.cn')
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = []
  const service = new CodeBuddySubscriptionService({
    authFiles: [authFile],
    origins: { cn: ['https://billing.example.test'] },
    fetch: (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      requests.push({ url, body, headers: new Headers(init?.headers) })
      if (url.endsWith('get-user-resource-summary')) return Response.json({ data: {
        SubscriptionPackageCode: 'TCACA_code_008',
        SubscriptionPackageName: '体验版',
        IsPaidUser: false,
        Packages: [{ PackageCode: 'TCACA_code_008', CycleTotalCapacity: '500', CycleRemainCapacity: '492.94', CycleUsedCapacity: '7.06' }],
      } })
      if (url.endsWith('get-user-resource-paid-packages')) return Response.json({ data: { Accounts: [] } })
      return Response.json({ data: { Accounts: [{ PackageCode: 'TCACA_code_008', PackageName: '体验版', CapacityType: 4, SlicePeriodUsageDetails: [{ CycleCapacitySizePrecise: '500', CycleCapacityRemainPrecise: '492.94', CycleCapacityUsedPrecise: '7.06', CycleEndTime: '2026-10-04T00:00:00Z' }] }] } })
    }) as typeof fetch,
  })

  const result = await service.read('codebuddy')
  assert.equal(requests.length, 3)
  assert.equal(requests[0]?.headers.get('authorization'), 'Bearer secret-token')
  assert.equal(requests[0]?.headers.get('x-user-id'), 'cn-user-1')
  assert.equal(requests[0]?.headers.get('accept-language'), 'zh')
  assert.deepEqual(requests[1]?.body.Status, [0, 3])
  assert.equal(result?.providerBalance?.total, 500)
  assert.equal(result?.providerBalance?.remaining, 492.94)
  assert.equal(result?.providerBalance?.used, 7.06)
  assert.equal(result?.planType, '体验版')
  assert.doesNotMatch(JSON.stringify(result), /secret-token/u)
})

test('CodeBuddy 统一适配器按认证域名读取 CN，WorkBuddy 继续按认证域名选择 CN', async () => {
  const authFile = writeAuth('www.codebuddy.cn')
  let calls = 0
  const fetch = (async () => { calls += 1; return Response.json({ data: { Packages: [] } }) }) as typeof globalThis.fetch
  const service = new CodeBuddySubscriptionService({ authFiles: [authFile], origins: { cn: ['https://billing.example.test'] }, fetch })
  assert.equal((await service.read('codebuddy'))?.providerBalance, undefined)
  assert.equal(calls, 1)
  assert.equal(await service.read('workbuddy'), null, 'fixture 没有 summary 套餐时应安全降级')
  assert.equal(calls, 2)
})

test('WorkBuddy 独立读取 WorkBuddy 认证与计费域名，不串用 CodeBuddy 用量', async () => {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'codingns-workbuddy-subscription-'))
  const authDirectory = join(homeDirectory, 'Library/Application Support/CodeBuddyExtension/Data/Public/auth')
  mkdirSync(authDirectory, { recursive: true })
  writeFileSync(join(authDirectory, 'Tencent-Cloud.coding-copilot.info'), JSON.stringify({
    account: { uid: 'codebuddy-user' },
    auth: { domain: 'www.codebuddy.cn', accessToken: 'codebuddy-token' },
  }), 'utf8')
  writeFileSync(join(authDirectory, 'workbuddy-desktop.info'), JSON.stringify({
    account: { uid: 'workbuddy-user' },
    auth: { domain: 'www.workbuddy.cn', accessToken: 'workbuddy-token' },
  }), 'utf8')
  const requests: Array<{ url: string; headers: Headers }> = []
  const service = new CodeBuddySubscriptionService({
    homeDirectory,
    fetch: (async (url: string, init?: RequestInit) => {
      requests.push({ url, headers: new Headers(init?.headers) })
      if (url.endsWith('get-user-resource-summary')) return Response.json({ data: {
        SubscriptionPackageName: 'WorkBuddy 体验版',
        Packages: [{ PackageCode: 'workbuddy-credit', CycleTotalCapacity: 100, CycleRemainCapacity: 80 }],
      } })
      return Response.json({ data: { Accounts: [] } })
    }) as typeof fetch,
  })

  const result = await service.read('workbuddy')
  assert.equal(requests.length, 3)
  assert.equal(requests[0]?.url, 'https://www.workbuddy.cn/billing/meter/get-user-resource-summary')
  assert.equal(requests[0]?.headers.get('authorization'), 'Bearer workbuddy-token')
  assert.equal(requests[0]?.headers.get('x-user-id'), 'workbuddy-user')
  assert.equal(requests[0]?.headers.get('x-product'), 'WorkBuddy')
  assert.equal(result?.provider?.id, 'workbuddy')
  assert.equal(result?.providerBalance?.total, 100)
  assert.equal(result?.providerBalance?.remaining, 80)
  assert.doesNotMatch(JSON.stringify(result), /codebuddy/u)
})

test('计费接口失败时按 origin 回退并安全返回空值', async () => {
  const authFile = writeAuth('www.codebuddy.ai')
  const calls: string[] = []
  const service = new CodeBuddySubscriptionService({
    authFiles: [authFile],
    origins: { international: ['https://first.example.test', 'https://second.example.test'] },
    fetch: (async (url: string) => {
      calls.push(url)
      return new Response('{}', { status: 403 })
    }) as typeof fetch,
  })
  assert.equal(await service.read('codebuddy'), null)
  assert.deepEqual(calls, [
    'https://first.example.test/billing/meter/get-user-resource-summary',
    'https://second.example.test/billing/meter/get-user-resource-summary',
  ])
})

test('CodeBuddy 国际版默认不会回退到 WorkBuddy 计费域名', async () => {
  const authFile = writeAuth('www.codebuddy.ai')
  const calls: string[] = []
  const service = new CodeBuddySubscriptionService({
    authFiles: [authFile],
    fetch: (async (url: string) => {
      calls.push(url)
      return new Response('{}', { status: 403 })
    }) as typeof fetch,
  })
  assert.equal(await service.read('codebuddy'), null)
  assert.deepEqual(calls, [
    'https://www.codebuddy.ai/billing/meter/get-user-resource-summary',
    'https://staging-codebuddy.tencent.com/billing/meter/get-user-resource-summary',
  ])
  assert.doesNotMatch(calls.join('\n'), /workbuddy/u)
})

test('企业账号优先读取企业月度额度接口', async () => {
  const authFile = writeAuth('www.codebuddy.cn')
  const calls: string[] = []
  const service = new CodeBuddySubscriptionService({
    authFiles: [authFile.replace('auth.json', 'enterprise-auth.json')],
    origins: { cn: ['https://billing.example.test'] },
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push(url)
      assert.equal(new Headers(init?.headers).get('x-enterprise-id'), 'enterprise-1')
      return Response.json({ data: { limitNum: 1000, credit: 125, cycleResetTime: '2026-11-01T00:00:00Z' } })
    }) as typeof fetch,
  })
  // 用单独文件覆盖 writeAuth 的个人账号结构，避免把企业字段放入公共 fixture。
  writeFileSync(authFile.replace('auth.json', 'enterprise-auth.json'), JSON.stringify({
    account: { uid: 'cn-user-1', enterpriseId: 'enterprise-1' },
    auth: { domain: 'www.codebuddy.cn', accessToken: 'secret-token' },
  }), 'utf8')
  const result = await service.read('codebuddy')
  assert.deepEqual(calls, ['https://billing.example.test/billing/meter/get-enterprise-user-usage'])
  assert.equal(result?.providerBalance?.total, 1000)
  assert.equal(result?.providerBalance?.used, 125)
  assert.equal(result?.providerBalance?.remaining, 875)
})

test('CodeBuddy 配置第三方 New-API 时不回退官方区域套餐', async () => {
  const authFile = writeAuth('www.codebuddy.cn')
  let officialCalls = 0
  const service = new ProviderSubscriptionService({
    codebuddy: {
      authFiles: [authFile],
      origins: { cn: ['https://billing.example.test'] },
      fetch: (async () => { officialCalls += 1; return Response.json({ data: { Packages: [] } }) }) as typeof fetch,
    },
    newApi: {
      sources: { codebuddy: { baseUrl: 'https://new-api.example.test', apiKey: 'upstream-secret' } },
      fetch: (async () => Response.json({ data: { object: 'token_usage', total_available: 80, total_used: 20, total_granted: 100, unit: 'credits' } })) as typeof fetch,
    },
  })
  const result = await service.read('codebuddy')
  assert.equal(result?.provider?.capability, 'new-api')
  assert.equal(result?.providerBalance?.remaining, 80)
  assert.equal(officialCalls, 0)
})
