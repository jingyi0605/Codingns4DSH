import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderSubscriptionService } from '../data/build/dist/host/cli-adapters/provider-subscription.js'
import { ZcodeSubscriptionService } from '../data/build/dist/host/cli-adapters/zcode-subscription.js'

test('ZCode 余额读取器解密凭据并携带设备标识查询套餐余额', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-zcode-balance-'))
  const secret = 'zcode-test-secret'
  writeFileSync(join(root, 'credentials.json'), JSON.stringify({ zcodejwttoken: encrypt('jwt-token', secret) }), 'utf8')
  writeFileSync(join(root, 'telemetry-state.json'), JSON.stringify({ deviceMid: 'device-test-1' }), 'utf8')
  const calls: Array<{ url: string; authorization: string | null; deviceMid: string | null }> = []
  const service = new ZcodeSubscriptionService({
    appVersion: '3.14.4',
    credentialsPath: join(root, 'credentials.json'),
    telemetryPath: join(root, 'telemetry-state.json'),
    credentialSecret: secret,
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers)
      calls.push({ url: String(url), authorization: headers.get('authorization'), deviceMid: headers.get('x-device-mid') })
      return Response.json({
        code: 0,
        data: {
          server_time: 1_790_781_471,
          plans: [{ plan_id: 'zcode-v3-start-plan', name: 'ZCode Start Plan', status: 'active', ends_at: 1_791_129_599 }],
          balances: [
            { show_name: 'GLM-5.3', total_units: 3_000_000, used_units: 100, remaining_units: 2_999_900, expires_at: 1_790_783_999 },
            { show_name: 'GLM-5.3-Flash', total_units: 5_000_000, used_units: 20_000, remaining_units: 4_980_000, expires_at: 1_790_783_999 },
          ],
        },
      })
    },
  })

  const result = await service.read()
  assert.equal(calls[0]?.url, 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=3.14.4')
  assert.equal(calls[0]?.authorization, 'Bearer jwt-token')
  assert.equal(calls[0]?.deviceMid, 'device-test-1')
  assert.equal(result?.provider?.id, 'zcode')
  assert.equal(result?.providerBalance?.planName, 'ZCode Start Plan')
  assert.equal(result?.providerBalance?.total, 8_000_000)
  assert.equal(result?.providerBalance?.used, 20_100)
  assert.equal(result?.providerBalance?.remaining, 7_979_900)
  assert.match(JSON.stringify(result?.providerBalance?.details), /GLM-5\.3-Flash/u)
  assert.doesNotMatch(JSON.stringify(result), /jwt-token/u)
})

test('ZCode 余额读取器只聚合活动套餐并安全处理失败响应', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-zcode-balance-filter-'))
  writeFileSync(join(root, 'credentials.json'), JSON.stringify({ zcodejwttoken: 'plain-token' }), 'utf8')
  writeFileSync(join(root, 'telemetry-state.json'), JSON.stringify({ deviceMid: 'device-test-2' }), 'utf8')
  let requestCount = 0
  const service = new ZcodeSubscriptionService({
    appVersion: '3.14.4',
    credentialsPath: join(root, 'credentials.json'),
    telemetryPath: join(root, 'telemetry-state.json'),
    fetch: async () => {
      requestCount += 1
      return Response.json({
        code: 0,
        data: {
          server_time: 1_790_781_471,
          plans: [
            { plan_id: 'expired-plan', name: '过期套餐', status: 'expired', ends_at: 1_790_000_000 },
            { plan_id: 'active-plan', name: '当前套餐', status: 'active', ends_at: 1_791_129_599 },
          ],
          balances: [
            { plan_id: 'expired-plan', show_name: '旧模型', total_units: 100, used_units: 0, remaining_units: 100 },
            { plan_id: 'active-plan', show_name: '当前模型', total_units: 200, used_units: 50, remaining_units: 150 },
          ],
        },
      })
    },
  })
  const result = await service.read()
  assert.equal(requestCount, 1)
  assert.equal(result?.providerBalance?.total, 200)
  assert.equal(result?.providerBalance?.remaining, 150)
  assert.doesNotMatch(JSON.stringify(result?.providerBalance?.details), /旧模型/u)

  const failed = new ZcodeSubscriptionService({
    appVersion: '3.14.4',
    credentialsPath: join(root, 'credentials.json'),
    telemetryPath: join(root, 'telemetry-state.json'),
    fetch: async () => Response.json({ code: 401, msg: 'unauthorized' }),
  })
  assert.equal(await failed.read(), null)
})

test('ProviderSubscriptionService 将 zcode 路由到余额读取器', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-zcode-balance-route-'))
  writeFileSync(join(root, 'credentials.json'), JSON.stringify({ zcodejwttoken: 'plain-token' }), 'utf8')
  writeFileSync(join(root, 'telemetry-state.json'), JSON.stringify({ deviceMid: 'device-test-3' }), 'utf8')
  const service = new ProviderSubscriptionService({
    zcode: {
      appVersion: '3.14.4',
      credentialsPath: join(root, 'credentials.json'),
      telemetryPath: join(root, 'telemetry-state.json'),
      fetch: async () => Response.json({
        code: 0,
        data: {
          plans: [{ name: 'Start', status: 'active' }],
          balances: [{ show_name: 'GLM-5.3', total_units: 10, used_units: 2, remaining_units: 8 }],
        },
      }),
    },
  })
  const result = await service.read('zcode')
  assert.equal(result?.providerBalance?.remaining, 8)
})

function encrypt(value: string, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
}
