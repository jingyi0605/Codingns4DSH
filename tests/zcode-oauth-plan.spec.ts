import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ZcodeAppServerDriver } from '../data/build/dist/host/cli-adapters/zcode-driver.js'

const ACCOUNT = 'fixture-account-a'
const OTHER_ACCOUNT = 'fixture-account-b'

/**
 * 复现三种本机状态：
 * - `oauth: true` + 别的槽位有 key：桌面端 OAuth 连个人版，个人版的 API Key 被记在
 *   `-team-coding-plan` 槽位（本机实测如此），适配器应在同家族内复用这把 key；
 * - `oauth: true` + 同族没有 key：个人版只可见、不可用，选中要给可操作原因；
 * - `oauth: false` + 没有 key：没有凭据的个人版根本不该出现。
 */
function fixture(options: { oauth?: boolean; family?: string; discoveredDesktop?: boolean; keys?: Array<{ slot: string; identity: string }> } = {}) {
  const family = options.family ?? 'bigmodel'
  const oauth = options.oauth ?? true
  // slot 是 provider id 的 kind 后缀（例如 `team-coding-plan`），拼出来必须与真实
  // 凭据键一致：account-provider:coding-plan:account:<family>-<slot>:account:<id>:api-key
  const keys = options.keys ?? [{ slot: 'team-coding-plan', identity: ACCOUNT }]
  const ids = {
    paid: `account:${family}-individual-coding-plan`,
    team: `account:${family}-team-coding-plan`,
    start: `account:${family}-start-plan`,
  }
  const models: Record<string, string[]> = {
    [ids.paid]: ['GLM-5.3', 'GLM-5.3-Flash'],
    [ids.team]: ['GLM-5.3', 'GLM-5.3-Flash'],
    [ids.start]: ['GLM-5.3-Flash', 'GLM-5.2'],
  }
  const labels: Record<string, string> = {
    [ids.paid]: `${family} Individual Coding Plan`,
    [ids.team]: `${family} Team Coding Plan`,
    [ids.start]: `${family} Start Plan`,
  }
  const home = mkdtempSync(join(tmpdir(), 'codingns-zcode-oauth-'))
  const root = join(home, '.zcode', 'v2'); mkdirSync(root, { recursive: true })
  const builtin = join(home, 'builtin.json')
  writeFileSync(builtin, JSON.stringify({ revision: 44, config: { providerConfigRules: { providerRules: [
    { providerId: ids.paid, config: { access: { type: 'zhipu-account', mode: 'individual-coding-plan' }, builtinModelIds: models[ids.paid] } },
    { providerId: ids.team, config: { access: { type: 'zhipu-account', mode: 'team-coding-plan' }, builtinModelIds: models[ids.team] } },
    { providerId: ids.start, config: { access: { type: 'zhipu-account', mode: 'start-plan' }, builtinModelIds: models[ids.start] } },
  ] } } }))
  writeFileSync(join(root, 'setting.json'), JSON.stringify({
    providerFamilyConnectionSelections: { [family]: { kind: 'individual-coding-plan' } },
    modelProviderFamilyModes: { [family]: oauth ? 'oauth' : 'api-key' },
  }))
  writeFileSync(join(root, 'telemetry-state.json'), JSON.stringify({ deviceMid: 'fixture-device-mid' }))
  writeFileSync(join(root, 'credentials.json'), JSON.stringify({
    ...Object.fromEntries(keys.map(entry => [
      `account-provider:coding-plan:account:${family}-${entry.slot}:account:${entry.identity}:api-key`,
      `${entry.slot}-fixture-key`,
    ])),
    zcodejwttoken: 'start-fixture-jwt',
    ...(oauth ? { [`oauth:${family}:access_token`]: 'oauth-fixture-token' } : {}),
  }))

  const calls: any[] = []
  const auth: any[] = []
  let active = ids.start
  let selection = { providerId: ids.start, modelId: 'GLM-5.3-Flash' }
  let nativeCounter = 0
  const desktopRuntime = { entry: 'fake-zcode.cjs', appVersion: '3.18.2', env: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin } }
  const driver = new ZcodeAppServerDriver({
    homeDirectory: home,
    ...(options.discoveredDesktop ? {} : { desktopRuntime }),
    binaries: ['fake-zcode'],
    spawnSync: (() => ({ status: 0, stdout: 'zcode 3.18.2', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(); const stderr = new PassThrough()
      let nativeId = ''
      const send = (v: any) => stdout.write(JSON.stringify(v) + '\n')
      const snapshot = () => ({ session: { sessionId: nativeId }, settings: { model: {
        current: { ...selection, providerId: active },
        available: (models[active] ?? []).map(modelId => ({
          ref: { providerId: active, modelId },
          providerLabel: labels[active],
          reasoning: { defaultLevel: 'high', levels: [{ value: 'high' }] },
        })),
      } } })
      // 原生行为：凭据拿到了就进入模型请求，没拿到就以失败终态收尾并回灌 errorMessage。
      const settleTurn = (result: any) => {
        if (result?.headersApplied === false) {
          send({ method: 'state.updated', params: { reason: 'prompt_failed', patch: { status: 'idle' } } })
          send({ method: 'session/event', params: { type: 'turn.failed', payload: { errorCode: 'model_request_failed', errorMessage: result?.errorMessage ?? 'auth rejected' } } })
          send({ method: 'v4/telemetry/event', params: { kind: 'turn.terminal', status: 'failed', errorCode: 'model_request_failed', errorMessage: result?.errorMessage ?? 'auth rejected' } })
          return
        }
        send({ method: 'state.updated', params: { reason: 'prompt_started', patch: { status: 'running' } } })
        send({ method: 'session/event', params: { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'ok' } } })
        send({ method: 'state.updated', params: { patch: { status: 'idle' } } })
      }
      return { stdout, stderr, stdin: { write(line: string) {
        const v = JSON.parse(line); calls.push(v)
        if (!v.method) { auth.push(v.result); settleTurn(v.result); return }
        let result: any = {}
        if (v.method === 'provider/updateAccountConfig') {
          const current = Object.entries(v.params.states).filter(([, s]: any) => s.current)
          assert.equal(current.length, 1, '原生只能有一个 current account-plan，不能同时置多个 true')
          active = current[0]![0]
        }
        if (v.method === 'session/create' || v.method === 'session/resume') {
          nativeId = v.method === 'session/resume' ? v.params.sessionId : `native-${++nativeCounter}`
          result = snapshot()
        }
        if (v.method === 'session/setModel') { selection = v.params.model; result = snapshot() }
        if (v.method === 'session/read') result = snapshot()
        send({ id: v.id, result })
        if (v.method === 'session/send') send({ id: 'headers', method: 'interaction/requestProviderRuntimeHeaders', params: { providerId: active, reason: 'model-request' } })
      } }, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  } as any)
  // Supply the desktop discovery result without looking at the Windows/macOS test host.
  if (options.discoveredDesktop) Object.assign(driver, { cachedRuntime: desktopRuntime })
  return { driver, home, root, calls, auth, builtin, ids }
}

const currentOf = (call: any) => Object.entries(call.params.states).find(([, s]: any) => s.current)?.[0]
const firstUpdate = (calls: any[]) => calls.find(v => v.method === 'provider/updateAccountConfig')

test('个人版 key 记在别的槽位时：同家族复用该 key，个人版可用并成为 current', async () => {
  const f = fixture({ discoveredDesktop: true })
  try {
    const catalog = await f.driver.listModels()
    assert.ok(catalog.groups.some(g => g.id === f.ids.paid), '个人版应出现在模型菜单中')
    assert.equal(f.auth.length, 0, '列目录阶段不应该发回合')
    assert.equal(currentOf(firstUpdate(f.calls)), f.ids.paid, '用户选中的个人版应成为 current')
    const snapshot = firstUpdate(f.calls)!
    assert.equal(snapshot.params.states[f.ids.paid].entitled, true)
    for await (const _event of f.driver.executeTurn({ sessionId: 's', modelId: f.ids.paid + '/GLM-5.3-Flash', messages: [], prompt: 'test' })) { /* 消费事件 */ }
    assert.equal(f.auth.length, 1)
    assert.equal(f.auth[0].headersApplied, true)
    assert.equal(f.auth[0].requestAuth.apiKey, 'team-coding-plan-fixture-key', '应下发同家族里那把可用 key')
    assert.ok(!JSON.stringify(f.calls).includes('oauth-fixture-token'), 'OAuth 登录令牌不得出现在任何协议参数里')
  } finally { f.driver.dispose() }
})

test('同一把 key 只列当前选中的套餐，来源槽位不重复出现；历史会话仍能切回它', async () => {
  const f = fixture()
  try {
    const catalog = await f.driver.listModels()
    assert.ok(catalog.groups.some(g => g.id === f.ids.paid), '个人版应可用')
    assert.ok(!catalog.groups.some(g => g.id === f.ids.team), '同一把 key 的来源槽位不应重复列出')
    const snapshot = firstUpdate(f.calls)!
    assert.equal(snapshot.params.states[f.ids.paid].current, true)
    assert.equal(snapshot.params.states[f.ids.team].entitled, true, '原生注册信息不变，历史会话仍可切到该槽位')
    // 旧会话带着 team 套餐（去重后不在目录里）时，仍应能用它自己的 key 发请求。
    for await (const _event of f.driver.executeTurn({ sessionId: 's', modelId: f.ids.team + '/GLM-5.3-Flash', messages: [], prompt: 'test' })) { /* 消费事件 */ }
    assert.equal(f.auth[0]?.headersApplied, true)
    assert.equal(f.auth[0]?.requestAuth.apiKey, 'team-coding-plan-fixture-key')
  } finally { f.driver.dispose() }
})

test('同家族没有可用 key 时：个人版仍可见，但选中后直接给出可操作原因', async () => {
  const f = fixture({ keys: [] })
  try {
    const catalog = await f.driver.listModels()
    assert.ok(catalog.groups.some(g => g.id === f.ids.paid), 'OAuth 连接的个人版仍应可见')
    assert.equal(currentOf(firstUpdate(f.calls)), f.ids.start, '没有可用凭据时不能把它当作 current')
    const events: any[] = []
    for await (const event of f.driver.executeTurn({ sessionId: 's', modelId: f.ids.paid + '/GLM-5.3-Flash', messages: [], prompt: 'test' })) events.push(event)
    assert.equal(f.auth.length, 1)
    assert.equal(f.auth[0].headersApplied, false)
    assert.match(String(f.auth[0].errorMessage), /OAuth|API Key/u)
    assert.equal(events.findLast(event => event.type === 'finish')?.reason, 'error')
    const text = events.filter(event => event.type === 'text-snapshot').map(event => event.text).join('\n')
    assert.match(text, /API Key/u, '失败信息里要带上可操作原因')
  } finally { f.driver.dispose() }
})

test('同家族存在两个账号身份时不做 key 回退', async () => {
  const f = fixture({ keys: [{ slot: 'team-coding-plan', identity: ACCOUNT }, { slot: 'offpeak-idle-plan', identity: OTHER_ACCOUNT }] })
  try {
    await f.driver.listModels()
    // 身份有歧义时个人版不可用；同族里自己带 key 的 team 套餐成为 current，不能替用户猜。
    assert.equal(currentOf(firstUpdate(f.calls)), f.ids.team, '身份有歧义时不能替用户猜')
    const events: any[] = []
    for await (const event of f.driver.executeTurn({ sessionId: 's', modelId: f.ids.paid + '/GLM-5.3-Flash', messages: [], prompt: 'test' })) events.push(event)
    assert.equal(f.auth[0]?.headersApplied, false)
    assert.equal(events.findLast(event => event.type === 'finish')?.reason, 'error')
  } finally { f.driver.dispose() }
})

test('非 OAuth 模式且同家族没有任何 key 时，个人版不出现在目录里', async () => {
  const f = fixture({ oauth: false, keys: [] })
  try {
    const catalog = await f.driver.listModels()
    assert.ok(!catalog.groups.some(g => g.id === f.ids.paid), '没有凭据的个人版不应出现')
    assert.equal(firstUpdate(f.calls)!.params.states[f.ids.paid].entitled, false)
  } finally { f.driver.dispose() }
})

test('族名含下划线（zai_cn）时 OAuth 连接与同族复用同样生效', async () => {
  const f = fixture({ family: 'zai_cn' })
  try {
    const catalog = await f.driver.listModels()
    assert.ok(catalog.groups.some(g => g.id === f.ids.paid), 'zai_cn 的个人版也应可选')
    assert.equal(currentOf(firstUpdate(f.calls)), f.ids.paid, '族名解析不能漏掉下划线')
  } finally { f.driver.dispose() }
})
