import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ZcodeAppServerDriver, resolvePreferredAccountProvider } from '../data/build/dist/host/cli-adapters/zcode-driver.js'

const PAID = 'account:bigmodel-individual-coding-plan'
const START = 'account:bigmodel-start-plan'
function fixture(misroute = false, desktop = true) {
  const home = mkdtempSync(join(tmpdir(), 'codingns-zcode-start-'))
  const root = join(home, '.zcode', 'v2'); mkdirSync(root, { recursive: true })
  const builtin = join(home, 'builtin.json')
  writeFileSync(builtin, JSON.stringify({ revision: 44, config: { providerConfigRules: { providerRules: [
    { providerId: PAID, config: { access: { type: 'zhipu-account', mode: 'individual-coding-plan' }, builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'] } },
    { providerId: START, config: { access: { type: 'zhipu-account', mode: 'start-plan' }, builtinModelIds: ['GLM-5.3-Flash', 'GLM-5.2'] } },
  ] } } }))
  writeFileSync(join(root, 'setting.json'), JSON.stringify({ providerFamilyConnectionSelections: { bigmodel: { kind: 'individual-coding-plan' } } }))
  const credentials = (start: boolean) => writeFileSync(join(root, 'credentials.json'), JSON.stringify({
    [`account-provider:coding-plan:${PAID}:account:test:api-key`]: 'paid-fixture-key',
    ...(start ? { zcodejwttoken: 'start-fixture-jwt' } : {}),
  }))
  credentials(true)
  const calls: any[] = []
  const auth: any[] = []
  let active = PAID
  let selection = { providerId: PAID, modelId: 'GLM-5.3-Flash' }
  let nativeCounter = 0
  const driver = new ZcodeAppServerDriver({
    homeDirectory: home,
    desktopRuntime: desktop ? { entry: 'fake-zcode.cjs', appVersion: '3.18.2', env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin } } : null,
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: 'zcode 3.18.2', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(); const stderr = new PassThrough()
      let nativeId = ''
      const send = (v: any) => stdout.write(JSON.stringify(v) + '\n')
      const snapshot = () => ({ session: { sessionId: nativeId }, settings: { model: {
        current: { ...selection, providerId: active }, available: (active === START ? ['GLM-5.3-Flash', 'GLM-5.2'] : ['GLM-5.3', 'GLM-5.3-Flash']).map(modelId => ({
          ref: { providerId: active, modelId }, providerLabel: active === START ? 'BigModel Start Plan' : 'BigModel Individual Coding Plan',
          reasoning: { defaultLevel: 'high', levels: [{ value: 'high' }] },
        })),
      } } })
      return { stdout, stderr, stdin: { write(line: string) {
        const v = JSON.parse(line); calls.push(v)
        if (!v.method) { auth.push(v.result); return }
        let result: any = {}
        if (v.method === 'provider/updateAccountConfig') {
          const current = Object.entries(v.params.states).filter(([,s]: any) => s.current)
          assert.equal(current.length, 1, '原生只能有一个 current account-plan，不能同时置多个 true')
          active = current[0]![0]
        }
        if (v.method === 'session/create' || v.method === 'session/resume') {
          nativeId = v.method === 'session/resume' ? v.params.sessionId : `native-${++nativeCounter}`
          result = snapshot()
        }
        if (v.method === 'session/setModel') {
          selection = v.params.model
          result = snapshot()
          if (misroute && selection.providerId === START) result.settings.model.current.providerId = PAID
          // 模拟真实 CLI 把 account-plan provider 强制映射到 current 的行为。
        }
        if (v.method === 'session/read') result = snapshot()
        send({ id: v.id, result })
        if (v.method === 'session/send') {
          send({ id: 'headers', method: 'interaction/requestProviderRuntimeHeaders', params: { providerId: active } })
          send({ method: 'state.updated', params: { reason: 'prompt_started', patch: { status: 'running' } } })
          send({ method: 'session/event', params: { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'ok' } } })
          send({ method: 'state.updated', params: { patch: { status: 'idle' } } })
        }
      } }, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  } as any)
  return { driver, home, root, calls, auth, credentials }
}

test('ZCode 同时显示付费和 Start Plan 原生模型，重复模型保持不同 provider 身份', async () => {
  const f = fixture()
  try {
    const catalog = await f.driver.listModels()
    for (const id of [PAID, START]) {
      const group = catalog.groups.find(g => g.id === id)
      assert.ok(group, id + ' 应在模型菜单中可选')
      assert.ok(group.models.some(m => m.id === id + '/GLM-5.3-Flash'))
    }
    assert.ok(catalog.groups.find(g => g.id === START)?.name.includes('Start Plan'))
    assert.equal(f.calls.filter(v => v.method === 'session/send').length, 0)
  } finally { f.driver.dispose() }
})

test('已有原生会话逐轮切换 Start / 付费，核对真实路由、JWT 与 API Key 不串用', async () => {
  const f = fixture()
  try {
    await f.driver.listModels()
    const before = f.calls.length
    const bindings: string[] = []
    for (const provider of [START, PAID, START]) {
      for await (const event of f.driver.executeTurn({ sessionId: 'dsh-existing', providerSessionId: 'native-original', modelId: provider + '/GLM-5.3-Flash', messages: [], prompt: 'test' })) {
        if (event.type === 'session-binding') bindings.push(event.providerSessionId)
      }
    }
    assert.deepEqual(bindings, ['native-original', 'native-original', 'native-original'])
    const turnCalls = f.calls.slice(before)
    assert.equal(turnCalls.filter(v => v.method === 'session/resume').length, 1)
    assert.equal(turnCalls.filter(v => v.method === 'session/create').length, 0)
    assert.deepEqual(turnCalls.filter(v => v.method === 'provider/updateAccountConfig').map(v => Object.entries(v.params.states).find(([,s]: any) => s.current)?.[0]), [START, PAID, START])
    assert.deepEqual(f.auth.map(v => v.requestAuth?.apiKey), ['start-fixture-jwt', 'paid-fixture-key', 'start-fixture-jwt'])
    assert.ok(turnCalls.filter(v => v.method === 'session/setModel').every(v => v.params.persistAsWorkspaceLastUsed === false))
  } finally { f.driver.dispose() }
})

test('登录态变化使 Start Plan 目录失效，失去凭据后不回退付费套餐或发送任务', async () => {
  const f = fixture()
  try {
    assert.ok((await f.driver.listModels()).groups.some(g => g.id === START))
    f.credentials(false)
    assert.ok(!(await f.driver.listModels()).groups.some(g => g.id === START))
    const before = f.calls.filter(v => v.method === 'session/send').length
    await assert.rejects(async () => { for await (const _event of f.driver.executeTurn({ sessionId: 's', modelId: START + '/GLM-5.2', messages: [], prompt: 'test' })) {} }, /Start Plan|凭据|不可用|available/)
    assert.equal(f.calls.filter(v => v.method === 'session/send').length, before)
  } finally { f.driver.dispose() }
})


test('原生返回错误套餐时在发送模型任务之前停止', async () => {
  const f = fixture(true)
  try {
    await f.driver.listModels()
    await assert.rejects(async () => { for await (const _event of f.driver.executeTurn({ sessionId: 's', modelId: START + '/GLM-5.3-Flash', messages: [], prompt: 'test' })) {} }, /套餐模型与所选不一致/)
    assert.equal(f.calls.filter(v => v.method === 'session/send').length, 0)
  } finally { f.driver.dispose() }
})

test('ZCode 默认套餐尊重当前选择，失效时只在同账户族内查找已保存套餐', () => {
  const team = 'account:bigmodel-team-coding-plan'
  const other = 'account:zai-team-coding-plan'
  const rules = [PAID, team, START, other].map(providerId => ({ providerId, config: {
    access: { mode: providerId === START ? 'start-plan' : providerId === PAID ? 'individual-coding-plan' : 'team-coding-plan' },
  } }))
  const settings = { providerFamilyConnectionSelections: { bigmodel: { kind: 'individual-coding-plan' } } }
  assert.equal(resolvePreferredAccountProvider(rules, settings, rule => rule.providerId === team, () => true), team)
  assert.equal(resolvePreferredAccountProvider(rules, settings, rule => rule.providerId === other, () => true), START)
  assert.equal(resolvePreferredAccountProvider(rules, settings, () => true, () => true), PAID)
  const startSettings = { providerFamilyConnectionSelections: { bigmodel: { kind: 'start-plan' } } }
  assert.equal(resolvePreferredAccountProvider(rules, startSettings, () => true, () => true), START)
})

test('独立 ZCode CLI 无桌面配置时仍可使用其原生账号目录执行回合', async () => {
  const f = fixture(false, false)
  try {
    const catalog = await f.driver.listModels()
    assert.ok(catalog.groups.some(group => group.id === PAID))
    const chunks = []
    for await (const event of f.driver.executeTurn({ sessionId: 'standalone', modelId: PAID + '/GLM-5.3-Flash', messages: [], prompt: 'test' })) chunks.push(event)
    assert.equal(chunks.at(-1)?.type, 'finish')
    assert.equal(chunks.at(-1)?.reason, 'stop')
    assert.equal(f.calls.filter(call => call.method === 'provider/updateAccountConfig').length, 0)
    assert.equal(f.calls.filter(call => call.method === 'session/send').length, 1)
  } finally { f.driver.dispose() }
})
