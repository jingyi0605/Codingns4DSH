import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Context } from '@deepseek-ai/cordis'
import { createSessionTitleOptimizationAdapter } from '../src/dsh-capabilities/host/session-title-adapter.js'
import { createSessionTitleOptimizationFeature } from '../src/host/features/session-title-optimization.js'
import { WorkspaceSessionEnhancementPanel } from '../src/client/features/workspace-session-enhancement-panel.js'
import { CodingNsSettingsSchema } from '../src/host/settings.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { fallbackOptimizedSessionTitle, isCompleteSessionTitle, SESSION_TITLE_SYSTEM_PROMPT } from '../src/shared/session-title.js'
import { FeatureResourceScopeImpl } from '../src/features/index.js'
import { createDshCapabilityRegistry } from '../src/dsh-capabilities/routes.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { createCodingNsSettingsBridge } from '../src/client/settings-bridge.js'
import { createCodingNsRpcHandler, createCodingNsSettingsRpcHandler } from '../src/host/rpc.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import type { CodingNsSettingsOperation } from '../src/dsh-capabilities/settings-store.js'

type Reply = string | Error | ((options: any) => AsyncIterable<any>)

/** 模拟原生流中间件的递归调用、持久标题投影和模型终态，不访问运行中的宿主。 */
function fixture(replies: Reply[] = ['排查 PeerHost 远程会话访问问题'], extra: Record<string, unknown> = {}) {
  let listener: any
  let removals = 0
  const calls: any[] = [], logs: any[] = []
  let title: any = { eventSeq: 2, title: '通过 Peerhost访问远程工作区会', messageSeqs: [1], source: { kind: 'fallback' } }
  const session = { append(type: string, data: any) {
    logs.push({ type, data })
    if (type === 'session/title') title = { ...data, eventSeq: title.eventSeq + 1 }
  } }
  const llm = {
    listProviders: () => [], listModels: async () => [],
    stream(options: any): AsyncIterable<any> {
      const next = async function* () {
        calls.push(options)
        const reply = replies.shift() ?? '修复工作区会话标题显示'
        if (reply instanceof Error) throw reply
        if (typeof reply === 'function') { yield* reply(options); return }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      return listener ? listener(options, next) : next()
    },
  }
  const ctx = {
    llm, sessions: { get: () => session }, sessionTitle: { get: () => title },
    on(_name: string, callback: any) { listener = callback; return () => { listener = undefined; removals++ } },
  }
  const adapter = createSessionTitleOptimizationAdapter(ctx, '0.2.1-alpha.1')!
  const controller = new AbortController()
  const prompt = '通过 Peerhost访问远程工作区会话时，需要定位标题显示异常并验证修复结果。'
  const request = Object.freeze({
    provider: 'configured-provider', model: 'configured-model', purpose: 'session-title', sessionId: 'session-1',
    system: '原生标题提示词', maxTokens: 64, signal: controller.signal,
    messages: Object.freeze([{ role: 'user', source: { kind: 'dsh-session-title-llm' }, content: [{ type: 'text', text: `Generate the session title from this JSON array of human messages:\n${JSON.stringify([{ seq: 1, text: prompt }])}` }] }]),
    ...extra,
  })
  return { adapter, ctx, request, controller, calls, logs, prompt, removals: () => removals,
    read: () => title,
    revise: (title: string, kind: string, messageSeqs: number[]) => session.append('session/title', { title, messageSeqs, source: { kind } }),
    rename: () => { session.append('session/title', { title: '我的手动标题', messageSeqs: [], source: { kind: 'user' } }) } }
}

async function output(stream: AsyncIterable<any>): Promise<string> {
  let text = ''
  for await (const chunk of stream) if (chunk.type === 'text-delta') text += chunk.text
  return text
}

test('旧设置缺省关闭，schema 支持开启并拒绝非布尔值', () => {
  assert.equal(DEFAULT_CODINGNS_SETTINGS.workspaceSessionEnhancement.optimizeSessionTitles, false)
  assert.equal(CodingNsSettingsSchema({ workspaceSessionEnhancement: {} } as never).workspaceSessionEnhancement.optimizeSessionTitles, false)
  assert.equal(CodingNsSettingsSchema({ workspaceSessionEnhancement: { optimizeSessionTitles: true } } as never).workspaceSessionEnhancement.optimizeSessionTitles, true)
  assert.throws(() => CodingNsSettingsSchema({ workspaceSessionEnhancement: { optimizeSessionTitles: 'true' } } as never))
})

test('客户端经真实设置 RPC 保存标题开关并驱动 Host，未知字段和只读写入仍拒绝', async (t) => {
  const f = fixture(['原生标题', '优化工作区会话标题', '恢复原生标题'])
  f.adapter.dispose()
  const resources = new FeatureResourceScopeImpl()
  t.after(() => resources.dispose())
  let settings = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  settings.modules.workspaceSessionEnhancement = true
  let revision = 1
  const listeners = new Set<(value: typeof settings) => void>()
  const writes: { namespace: string; ops: readonly CodingNsSettingsOperation[] }[] = []
  const provider = {
    writable: true,
    describe: () => [{ ns: '@jingyi0605/codingns4dsh', revision, value: settings }],
    get: () => settings,
    mutate: async (namespace: string, ops: readonly CodingNsSettingsOperation[], expectedRevision?: number) => {
      if (expectedRevision !== undefined) assert.equal(expectedRevision, revision)
      const next = structuredClone(settings)
      for (const operation of ops) {
        const [group, field] = operation.path
        assert.equal(operation.path.length, 2)
        const target = (next as any)[group!]
        if (operation.op === 'unset') delete target[field!]
        else target[field!] = operation.value
      }
      // 使用真实 schema 模拟原生持久设置写入；不是绕过 RPC 白名单直接改内存。
      settings = CodingNsSettingsSchema(next)
      writes.push({ namespace, ops })
      revision++
      for (const listener of listeners) listener(settings)
    },
  }
  const settingsHandler = createCodingNsSettingsRpcHandler(provider as never)
  const table = new CodingNsRpcTable()
  table.register('settings', settingsHandler)
  const rpcHandler = createCodingNsRpcHandler(table)
  const bridge = createCodingNsSettingsBridge(undefined, {
    call: async (_channel, endpoint, payload) => rpcHandler(endpoint, payload, f.controller.signal),
  } as never)
  t.after(() => bridge.dispose())
  const feature = createSessionTitleOptimizationFeature()
  await feature.start({ descriptor: feature.descriptor, resources, services: {
    dshContext: f.ctx as never, dshVersion: '0.2.1-alpha.1', rpc: table,
    settings: { get: () => settings, watch: (listener) => { listeners.add(listener); return () => listeners.delete(listener) } } as never,
  } })
  await bridge.load()
  assert.equal(await output(f.ctx.llm.stream(f.request)), '原生标题')
  for (const [enabled, title] of [[true, '优化工作区会话标题'], [false, '恢复原生标题']] as const) {
    const ops = [{ op: 'set', path: ['workspaceSessionEnhancement', 'optimizeSessionTitles'], value: enabled }] as const
    assert.equal(await bridge.mutate(ops, revision), true)
    assert.deepEqual(writes.at(-1), { namespace: '@jingyi0605/codingns4dsh', ops })
    assert.equal(bridge.getSnapshot().value?.workspaceSessionEnhancement.optimizeSessionTitles, enabled)
    assert.equal(await output(f.ctx.llm.stream(f.request)), title)
    assert.equal(f.calls.at(-1).system.includes('12～24'), enabled)
  }
  for (const path of [['workspaceSessionEnhancement', 'unknownField'], ['workspaceSessionEnhancement', 'optimizeSessionTitles', 'nested']]) {
    await assert.rejects(settingsHandler('set', { ops: [{ op: 'set', path, value: true }] }), { code: 'CODINGNS_SETTINGS_FIELD_FORBIDDEN' })
  }
  provider.writable = false
  await assert.rejects(settingsHandler('set', { ops: [{ op: 'set', path: ['workspaceSessionEnhancement', 'optimizeSessionTitles'], value: true }] }), { code: 'CODINGNS_SETTINGS_READ_ONLY' })
  assert.equal(writes.length, 2, '被拒绝的字段和只读请求不得进入持久设置写入')
})

test('标题长度同时考虑中文、英文词数、中英混排、版本和 Unicode 字节', () => {
  assert.equal(isCompleteSessionTitle('发布 0.2.1-beta.7 并同步版本'), true)
  assert.equal(isCompleteSessionTitle('排查 PeerHost 远程会话访问问题'), true)
  assert.equal(isCompleteSessionTitle('中文'.repeat(13)), false)
  assert.equal(isCompleteSessionTitle('😀'.repeat(21)), false)
  assert.equal(isCompleteSessionTitle('a '.repeat(11).trim()), false)
  for (const title of ['只输出标题\n另外补充解释', '标题显示异常，', '半截标题…']) assert.equal(isCompleteSessionTitle(title), false)
})

test('模型失败的兜底优先保留完整短语，长文字显式省略并保持字节预算', () => {
  const title = fallbackOptimizedSessionTitle('排查局域网访问问题，随后请分析全部工作区会话及其复杂的模型路由和权限设置。')
  assert.equal(title, '排查局域网访问问题')
  const long = fallbackOptimizedSessionTitle('通过 Peerhost访问远程工作区会话时需要定位标题显示异常并验证修复结果')
  assert.match(long, /…$/u)
  assert.ok(Buffer.byteLength(long) <= 80)
  assert.ok(long.length > '通过 Peerhost访问远程工作区会'.length)
  assert.equal(fallbackOptimizedSessionTitle('发布 0.2.1-beta.7'), '发布 0.2.1-beta.7')
})

test('开关关闭时原请求及结果原样透传，开启后使用原模型并记录实际请求', async (t) => {
  const f = fixture(['原生标题', '“发布 0.2.1-beta.7 并同步版本”'])
  t.after(() => f.adapter.dispose())
  assert.equal(await output(f.ctx.llm.stream(f.request)), '原生标题')
  assert.equal(f.calls[0], f.request)
  assert.equal(f.logs.length, 0)
  f.adapter.setEnabled(true)
  assert.equal(await output(f.ctx.llm.stream(f.request)), '发布 0.2.1-beta.7 并同步版本')
  assert.equal(f.calls.length, 2, '每个正常标题只请求一次，自身中间件不得递归')
  assert.equal(f.calls[1].provider, f.request.provider)
  assert.equal(f.calls[1].model, f.request.model)
  assert.equal(f.calls[1].messages, f.request.messages)
  assert.equal(f.request.system, '原生标题提示词', '不能修改原生冻结请求')
  assert.match(f.calls[1].system, /12～24/u)
  const recorded = f.logs[0].data
  assert.equal(recorded.system, f.calls[1].system)
  assert.deepEqual(recorded.route, { provider: f.request.provider, model: f.request.model })
  assert.deepEqual(recorded.messageSeqs, [1])
})

test('alpha.2 的当前标题并入系统提示，字段缺失时提示与今天逐字一致', async (t) => {
  // 旧版本 DSH 不带 currentTitle：系统提示必须保持原样，生成行为零变化。
  const legacy = fixture(['发布 0.2.1-beta.7 并同步版本'])
  t.after(() => legacy.adapter.dispose())
  legacy.adapter.setEnabled(true)
  assert.equal(await output(legacy.ctx.llm.stream(legacy.request)), '发布 0.2.1-beta.7 并同步版本')
  assert.equal(legacy.calls.length, 1)
  assert.equal(legacy.calls[0].system, SESSION_TITLE_SYSTEM_PROMPT)

  // alpha.2 带上当前标题：提示里追加沿用措辞的指引，不改动用户消息快照。
  const current = fixture(['发布 0.2.1-beta.7 并同步版本'], {
    currentTitle: { title: '同步插件版本号', messageSeqs: [1], source: { kind: 'provider' }, eventSeq: 3, updatedAt: 0 },
  })
  t.after(() => current.adapter.dispose())
  current.adapter.setEnabled(true)
  assert.equal(await output(current.ctx.llm.stream(current.request)), '发布 0.2.1-beta.7 并同步版本')
  assert.match(current.calls[0].system, /会话当前标题是「同步插件版本号」/u)
  assert.match(current.calls[0].system, /只有主题确实变化时才改写/u)
  assert.equal(current.calls[0].messages, current.request.messages, '只增强系统提示，不改动消息快照')

  // 空标题与非法形状都按缺失处理，不能把 undefined 写进提示。
  for (const currentTitle of [{ title: '   ' }, { title: 42 }, 'unexpected', null]) {
    const malformed = fixture(['发布 0.2.1-beta.7 并同步版本'], { currentTitle })
    t.after(() => malformed.adapter.dispose())
    malformed.adapter.setEnabled(true)
    await output(malformed.ctx.llm.stream(malformed.request))
    assert.equal(malformed.calls[0].system, SESSION_TITLE_SYSTEM_PROMPT, JSON.stringify(currentTitle))
  }
})

test('超长结果重新概括一次，完整版本名称不靠截取获得', async (t) => {  const f = fixture(['请帮我分析'.repeat(20), '发布 0.2.1-beta.7 并同步版本'])
  t.after(() => f.adapter.dispose())
  f.adapter.setEnabled(true)
  assert.equal(await output(f.ctx.llm.stream(f.request)), '发布 0.2.1-beta.7 并同步版本')
  assert.equal(f.calls.length, 2)
  assert.match(f.calls[1].messages.at(-1).content[0].text, /重新概括完整主题/u)
  assert.equal(f.logs.filter((event) => event.type === 'session/title').length, 0, '成功结果仍交给 DSH 接纳和保存')
})

test('格式持续不合格时最多两次调用，改善 fallback 且不伪造模型生成成功', async (t) => {
  const f = fixture(['过长标题'.repeat(30), '仍然过长'.repeat(30)])
  t.after(() => f.adapter.dispose())
  f.adapter.setEnabled(true)
  await assert.rejects(output(f.ctx.llm.stream(f.request)), /did not produce/u)
  assert.equal(f.calls.length, 2)
  assert.equal(f.read().source.kind, 'fallback')
  assert.equal(f.read().source.model, undefined)
  assert.notEqual(f.read().title, '通过 Peerhost访问远程工作区会')
  assert.deepEqual(f.read().messageSeqs, [1])
})

test('认证错误和失败终态保留真实错误，不接受半截输出或增加重试', async (t) => {
  const f = fixture([async function* () {
    yield { type: 'text-delta', index: 0, text: '模型已输出半截文字' }
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_CREDENTIAL', message: 'credential rejected' } } }
  }])
  t.after(() => f.adapter.dispose())
  f.adapter.setEnabled(true)
  await assert.rejects(output(f.ctx.llm.stream(f.request)), (error: any) => error.message === 'credential rejected' && error.code === 'INVALID_CREDENTIAL')
  assert.equal(f.calls.length, 1)
  assert.equal(f.read().source.kind, 'fallback')
  assert.notEqual(f.read().title, '模型已输出半截文字')
})

test('完整块与增量流不会重复拼接标题', async (t) => {
  const title = '修复工作区会话标题显示'
  const f = fixture([
    async function* () { yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }; yield { type: 'finish', reason: { kind: 'stop' } } },
    async function* () { yield { type: 'text-delta', index: 0, text: title }; yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }; yield { type: 'finish', reason: { kind: 'stop' } } },
  ])
  t.after(() => f.adapter.dispose())
  f.adapter.setEnabled(true)
  assert.equal(await output(f.ctx.llm.stream(f.request)), title)
  assert.equal(await output(f.ctx.llm.stream(f.request)), title)
})

test('普通对话、压缩和未知标题输入不经过优化', async (t) => {
  const f = fixture(['对话内容', '压缩内容', '第三方标题'])
  t.after(() => f.adapter.dispose())
  f.adapter.setEnabled(true)
  for (const request of [{ ...f.request, purpose: undefined }, { ...f.request, purpose: 'compaction' }, { ...f.request, messages: [] }]) {
    await output(f.ctx.llm.stream(request))
    assert.equal(f.calls.at(-1), request)
  }
  assert.equal(f.logs.length, 0)
})

test('并发会话的递归隔离互不干扰', async (t) => {
  const f = fixture(['修复局域网访问问题', '优化工作区会话标题'])
  t.after(() => f.adapter.dispose())
  f.adapter.setEnabled(true)
  assert.deepEqual(await Promise.all([output(f.ctx.llm.stream(f.request)), output(f.ctx.llm.stream({ ...f.request, sessionId: 'session-2' }))]), ['修复局域网访问问题', '优化工作区会话标题'])
  assert.equal(f.calls.length, 2)
  assert.ok(f.calls.every((request) => request.system.includes('12～24')))
})

test('人工改名及新标题修订不会被迟到的失败兜底覆盖', async (t) => {
  for (const kind of ['user', 'fallback', 'provider']) {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const f = fixture([async function* () { await gate; throw new Error('late failure') }])
    t.after(() => f.adapter.dispose())
    f.adapter.setEnabled(true)
    const pending = output(f.ctx.llm.stream(f.request))
    f.revise('较新修订的标题', kind, kind === 'user' ? [] : [1])
    release()
    await assert.rejects(pending, /late failure/u)
    assert.equal(f.read().title, '较新修订的标题')
    assert.equal(f.read().source.kind, kind)
  }
})

test('原有人工和模型标题以及消息来源不匹配时不能补写 fallback', async (t) => {
  for (const [kind, seq] of [['user', 1], ['provider', 1], ['fallback', 2]] as const) {
    const f = fixture([new Error('model unavailable')])
    t.after(() => f.adapter.dispose())
    f.revise('已有标题', kind, [seq])
    f.adapter.setEnabled(true)
    await assert.rejects(output(f.ctx.llm.stream(f.request)), /model unavailable/u)
    assert.equal(f.read().title, '已有标题')
    assert.equal(f.logs.filter((event) => event.type === 'session/title').length, 1)
  }
})

test('真实 Cordis 服务探测和 waterfall 保留其他中间件，嵌套调用不递归', async (t) => {
  const f = fixture()
  f.adapter.dispose()
  const app = new Context()
  t.after(() => app.fiber.dispose())
  const calls: any[] = [], observed: any[] = []
  const llm = {
    listProviders: () => [], listModels: async () => [],
    stream(options: any): AsyncIterable<any> {
      return (app as any).waterfall(llm, 'llm/stream', options, async function* (request: any) {
        calls.push(request)
        yield { type: 'text-delta', index: 0, text: '优化工作区会话标题生成' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })
    },
  }
  await app.plugin((ctx) => {
    ctx.provide('llm', llm)
    ctx.provide('sessionTitle', f.ctx.sessionTitle)
    ctx.provide('sessions', f.ctx.sessions)
    // 模拟先于标题优化安装的 CLI 中间件：标题请求继续走原生链。
    ;(ctx as any).on('llm/stream', async function* (options: any, next: () => AsyncIterable<any>) {
      observed.push(options)
      yield* next()
    }, { global: true })
  })
  let adapter: ReturnType<typeof createSessionTitleOptimizationAdapter>
  await app.plugin((ctx) => {
    assert.throws(() => Reflect.get(ctx, 'sessionTitle'), /without inject/u)
    adapter = createSessionTitleOptimizationAdapter(ctx, '0.2.1-alpha.1')
  })
  assert.ok(adapter)
  adapter.setEnabled(true)
  assert.equal(await output(llm.stream(f.request)), '优化工作区会话标题生成')
  assert.equal(calls.length, 1)
  assert.match(calls[0].system, /12～24/u)
  assert.equal(observed.length, 2, '外层与嵌套请求都保留先前的中间件')
  adapter.dispose()
  adapter.dispose()
  await output(llm.stream(f.request))
  assert.equal(calls.at(-1), f.request, '释放后不残留标题中间件')
})

test('停用与原生取消会中止当前请求，不回写新兜底', async (t) => {
  for (const cancel of ['setting', 'native', 'dispose']) {
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const f = fixture([async function* (options) {
      started()
      await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    }])
    t.after(() => f.adapter.dispose())
    f.adapter.setEnabled(true)
    const pending = output(f.ctx.llm.stream(f.request))
    await ready
    if (cancel === 'setting') f.adapter.setEnabled(false)
    if (cancel === 'native') f.controller.abort(new Error('native cancelled'))
    if (cancel === 'dispose') f.adapter.dispose()
    await assert.rejects(pending)
    assert.equal(f.logs.filter((event) => event.type === 'session/title').length, 0)
  }
})

test('主模块和子开关共同控制 Host，后台设置更新即时生效，释放时注销资源', async () => {
  const f = fixture(['原生标题', '优化会话标题', '恢复原生标题'])
  f.adapter.dispose()
  const module = createSessionTitleOptimizationFeature()
  const resources = new FeatureResourceScopeImpl()
  let settings = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  let watch: any
  await module.start({ descriptor: module.descriptor, resources, services: {
    dshContext: f.ctx as never, dshVersion: '0.2.1-alpha.1', rpc: {} as never,
    settings: { get: () => settings, watch: (listener) => { watch = listener; return () => { watch = undefined } } } as never,
  } })
  settings.workspaceSessionEnhancement.optimizeSessionTitles = true
  watch(settings)
  assert.equal(await output(f.ctx.llm.stream(f.request)), '原生标题', '主模块关闭时子开关不生效')
  settings.modules.workspaceSessionEnhancement = true
  watch(settings)
  assert.equal(await output(f.ctx.llm.stream(f.request)), '优化会话标题')
  assert.match(f.calls.at(-1).system, /12～24/u)
  settings.workspaceSessionEnhancement.optimizeSessionTitles = false
  watch(settings)
  assert.equal(await output(f.ctx.llm.stream(f.request)), '恢复原生标题')
  assert.equal(f.calls.at(-1), f.request)
  await resources.dispose()
  assert.equal(watch, undefined)
  assert.equal(f.removals(), 2)
})

test('支持版本按结构接入，旧版和缺失标题服务明确降级', () => {
  const f = fixture()
  f.adapter.dispose()
  for (const version of ['0.1.5-rc.3', '0.1.6-alpha.2', '0.1.7-rc.2']) {
    const profile = createDshCapabilityRegistry(version, 'host', f.ctx).getProfile(f.ctx)
    assert.equal(profile.capabilities.get('session.title')?.status, 'unavailable')
    assert.equal(createSessionTitleOptimizationAdapter(f.ctx, version), undefined)
    assert.ok(profile.diagnostics.some((entry) => entry.capability === 'session.title'))
  }
  for (const version of ['0.2.0-rc.2', '0.2.1-alpha.1']) {
    const adapter = createSessionTitleOptimizationAdapter(f.ctx, version)
    assert.ok(adapter)
    adapter.dispose()
  }
  assert.equal(createSessionTitleOptimizationAdapter({ ...f.ctx, sessionTitle: undefined }, '0.2.1-alpha.1'), undefined)
})

test('设置面板显示优化开关，主模块关闭和只读状态禁用输入', () => {
  const services = { locale: { bind: () => resolveCodingNsTranslator(), subscribe: () => () => {}, getSnapshot: () => ({ revision: 1 }) }, settings: { mutate: async () => true } } as any
  for (const [enabled, writable] of [[true, true], [false, true], [true, false]]) {
    const value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
    value.workspaceSessionEnhancement.optimizeSessionTitles = true
    const markup = renderToStaticMarkup(createElement(WorkspaceSessionEnhancementPanel, {
      services, enabled: enabled!, snapshot: { value, status: 'ready', writable: writable!, revision: 1 }, notify: () => {},
    }))
    const input = markup.match(/<input[^>]+aria-label="优化DSH会话标题生成逻辑"[^>]*>/u)?.[0]
    assert.ok(input)
    assert.match(input, /checked/u)
    assert.equal(input.includes('disabled'), !enabled || !writable)
  }
})
