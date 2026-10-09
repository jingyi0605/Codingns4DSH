import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readDshDefaultProvider, readDshProviderSource } from '../data/build/dist/host/cli-adapters/dsh-config.js'
import { ProviderSubscriptionService } from '../data/build/dist/host/cli-adapters/provider-subscription.js'

const usage = () => ({
  authenticated: true,
  planType: null,
  primary: null,
  secondary: null,
  monthly: null,
  rateLimitReachedType: null,
  resetCredits: null,
  capturedAt: new Date().toISOString(),
})

function withDshProfile(run: (home: string) => Promise<void> | void): Promise<void> | void {
  const home = mkdtempSync(join(tmpdir(), 'codingns-dsh-config-'))
  const profile = join(home, 'profiles', 'stage0')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(home, '.credentials.yaml'), 'refs:\n  GLOR_API_KEY: profile-secret\n', 'utf8')
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    '- id: agent-default-model',
    '  config:',
    '    provider: glor',
    '    model: deepseek-v4.1-flash',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      glor:',
    '        apiKeyEnv: GLOR_API_KEY',
    '        baseURL: https://upstream.example.test:1443/',
    '        models:',
    '          - id: deepseek-v4.1-flash',
    '',
  ].join('\n'), 'utf8')
  const previousHome = process.env.DSH_HOME
  const previousProfile = process.env.CODINGNS4DSH_PROFILE_NAME
  process.env.DSH_HOME = home
  process.env.CODINGNS4DSH_PROFILE_NAME = 'stage0'
  const restore = (): void => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousProfile === undefined) delete process.env.CODINGNS4DSH_PROFILE_NAME
    else process.env.CODINGNS4DSH_PROFILE_NAME = previousProfile
    rmSync(home, { recursive: true, force: true })
  }
  try {
    const result = run(home)
    if (result instanceof Promise) return result.finally(restore)
    restore()
  } catch (error) {
    restore()
    throw error
  }
}

test('从活动 DSH Profile 读取默认 Provider 和自定义上游凭据', () => {
  withDshProfile(() => {
    assert.equal(readDshDefaultProvider(), 'glor')
    assert.deepEqual(readDshProviderSource('glor'), {
      baseUrl: 'https://upstream.example.test:1443/',
      apiKey: 'profile-secret',
    })
  })
})

test('DSH 使用自定义 Provider 时不会回退到官方 DeepSeek 余额', async () => {
  await withDshProfile(async () => {
    const service = new ProviderSubscriptionService()
    const expected = usage()
    service.newApi.readWithKind = async () => ({ usage: expected, kind: 'new-api' })
    service.sub2api.readWithKind = async () => null
    service.deepseek.read = async () => { throw new Error('不应读取官方 DeepSeek 余额') }
    const result = await service.read('dsh')
    assert.deepEqual(result, expected)
  })
})
