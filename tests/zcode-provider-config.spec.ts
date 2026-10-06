import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readZcodeProviderConfigs } from '../data/build/dist/host/cli-adapters/zcode-provider-config.js'
import { ProviderSubscriptionService } from '../data/build/dist/host/cli-adapters/provider-subscription.js'
import { resolveNewApiSources } from '../data/build/dist/host/cli-adapters/new-api-subscription.js'
import type { CliSubscriptionUsage } from '../data/build/dist/shared/contracts/subscription.js'

function fixture(t: any, rules: object[], templates: object[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'codingns-zcode-providers-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  mkdirSync(join(home, '.zcode', 'v2'), { recursive: true })
  const builtinProviderConfigPath = join(home, 'builtin.json')
  writeFileSync(builtinProviderConfigPath, JSON.stringify({ config: { providerConfigRules: { templateRules: templates, providerRules: [] } } }))
  writeFileSync(join(home, '.zcode', 'v2', 'provider_config.json'), JSON.stringify({ config: { providerConfigRules: { providerRules: rules } } }))
  return { homeDirectory: home, builtinProviderConfigPath, runtime: null }
}

const customRule = (providerId: string, baseUrl: string) => ({ providerId, templateId: 'anthropic', config: {
  api: { type: 'anthropic-messages', baseUrl }, access: { type: 'api-key', apiKey: `${providerId}-secret` },
} })
const usage = (): CliSubscriptionUsage => ({ authenticated: true, planType: null, primary: null, secondary: null,
  monthly: null, rateLimitReachedType: null, resetCredits: null, capturedAt: new Date().toISOString() })

test('ZCode 个人 Provider 继承模板地址，并读取 access 内嵌密钥和个人地址覆盖', (t) => {
  const options = fixture(t, [
    { providerId: 'deepseek', templateId: 'deepseek', config: { access: { type: 'api-key', apiKey: 'personal-secret' } } },
    { ...customRule('custom', 'https://upstream.example.test/anthropic'), templateId: 'deepseek' },
  ], [{ templateId: 'deepseek', config: { api: { type: 'anthropic-messages', baseUrl: 'https://api.deepseek.com/anthropic' } } }])
  assert.deepEqual(readZcodeProviderConfigs('deepseek', options), [{ providerId: 'deepseek', source: {
    baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'personal-secret' } }])
  assert.equal(readZcodeProviderConfigs('custom', options)[0]?.source?.baseUrl, 'https://upstream.example.test/anthropic')
  assert.deepEqual(readZcodeProviderConfigs('missing', options), [])
})

test('ZCode 账号凭据解密、隔离 Provider 并拒绝错误密文', (t) => {
  const providerId = 'account:bigmodel-individual-coding-plan'
  const options = fixture(t, [{ providerId, config: { access: { mode: 'individual-coding-plan' },
    api: { baseUrl: 'https://upstream.example.test' } } }])
  const secret = 'credential-test-secret'; const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv)
  const encrypted = Buffer.concat([cipher.update('decrypted-secret'), cipher.final()])
  const value = `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
  writeFileSync(join(options.homeDirectory, '.zcode', 'v2', 'credentials.json'), JSON.stringify({
    [`account-provider:coding-plan:${providerId}:account:user:api-key`]: value,
    'account-provider:coding-plan:other:account:user:api-key': 'unrelated-secret',
  }))
  assert.equal(readZcodeProviderConfigs(providerId, { ...options, credentialSecret: secret })[0]?.source?.apiKey, 'decrypted-secret')
  assert.equal(readZcodeProviderConfigs(providerId, { ...options, credentialSecret: 'wrong' })[0]?.source, null)
})

for (const kind of ['new-api', 'sub2api'] as const) {
  test(`ZCode 按当前模型匹配 ${kind}，切换模型重新选择来源且不读 Start Plan`, async (t) => {
    const options = fixture(t, [customRule('first', 'https://first.example.test/v1'), customRule('second', 'https://second.example.test/anthropic')])
    const service = new ProviderSubscriptionService({ zcode: options })
    const calls: string[] = []
    const read = async (_adapter: string, provider: string | undefined, source: any) => {
      calls.push(`${provider}:${source.baseUrl}`)
      return { kind, usage: usage() }
    }
    service.newApi.readWithKind = kind === 'new-api' ? read as never : async () => null
    service.sub2api.readWithKind = kind === 'sub2api' ? read as never : async () => null
    service.zcode.read = async () => { assert.fail('自定义 Provider 不得读取 Start Plan') }
    assert.ok(await service.read('zcode', 'zcode', 'first/claude-sonnet'))
    assert.ok(await service.read('zcode', 'zcode', 'second/claude-sonnet'))
    assert.deepEqual(calls, ['first:https://first.example.test/v1', 'second:https://second.example.test/anthropic'])
  })
}

test('ZCode 官方 DeepSeek 继承 Anthropic 地址后查询官方余额，包含自定义 Provider 名称', async (t) => {
  const options = fixture(t, [customRule('my-deepseek', 'https://api.deepseek.com/anthropic')])
  const calls: string[] = []
  const service = new ProviderSubscriptionService({ zcode: options, deepseek: { fetch: async (url, init) => {
    calls.push(String(url))
    if (String(url).endsWith('/user/balance')) {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer my-deepseek-secret')
      return Response.json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '8.5' }] })
    }
    return new Response('', { status: 404 })
  } } })
  service.zcode.read = async () => { assert.fail('DeepSeek 不得读取 Start Plan') }
  service.newApi.readWithKind = async () => { assert.fail('官方地址不得探测 New-API') }
  const result = await service.read('zcode', 'zcode', 'my-deepseek/deepseek-flash')
  assert.equal(result?.provider?.id, 'deepseek')
  assert.equal(result?.deepseek?.balances[0]?.totalBalance, 8.5)
  assert.equal(calls[0], 'https://api.deepseek.com/user/balance')
  assert.doesNotMatch(JSON.stringify(result), /my-deepseek-secret/u)
})

test('ZCode 自定义上游鉴别失败或凭据缺失不能回退到其它账号余额', async (t) => {
  const options = fixture(t, [customRule('unknown', 'https://unknown.example.test/v1'),
    { providerId: 'empty', config: { api: { baseUrl: 'https://empty.example.test' }, access: { type: 'api-key' } } }])
  const service = new ProviderSubscriptionService({ zcode: options })
  service.newApi.readWithKind = async () => null
  service.sub2api.readWithKind = async () => null
  service.zcode.read = async () => { assert.fail('未识别上游不能借用 Start Plan') }
  for (const model of ['unknown/model', 'empty/model', 'missing/model']) assert.equal(await service.read('zcode', 'zcode', model), null)
})

test('ZCode Start Plan 模型仍查询官方套餐，个人 Provider 不干扰它', async (t) => {
  const options = fixture(t, [customRule('custom', 'https://custom.example.test/v1'),
    { providerId: 'account:start', config: { access: { mode: 'start-plan' } } }])
  const service = new ProviderSubscriptionService({ zcode: options })
  service.zcode.read = async () => usage()
  service.newApi.readWithKind = async () => { assert.fail('Start Plan 不探测个人上游') }
  assert.ok(await service.read('zcode', 'zcode', 'account:start/GLM-5.3'))
})

test('New-API 自动发现兼容 ZCode 旧规则格式，仍只返回指定 Provider', (t) => {
  const options = fixture(t, [
    { providerId: 'first', config: { baseUrl: 'https://first.example.test/v1', apiKey: 'first-secret' } },
    { providerId: 'second', config: { baseUrl: 'https://second.example.test/v1', apiKey: 'second-secret' } },
  ])
  const previous = { personal: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, builtin: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE }
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = join(options.homeDirectory, '.zcode', 'v2', 'provider_config.json')
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = options.builtinProviderConfigPath
  t.after(() => {
    if (previous.personal === undefined) delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
    else process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = previous.personal
    if (previous.builtin === undefined) delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
    else process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = previous.builtin
  })
  assert.deepEqual(resolveNewApiSources('zcode', 'second'), [{ baseUrl: 'https://second.example.test/v1', apiKey: 'second-secret' }])
})
