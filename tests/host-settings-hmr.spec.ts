import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { CodingNsConfigSchema, CodingNsSettingsSchema, registerCodingNsSettings } from '../data/build/dist/host/settings.js'
import { installTerminalController } from '../data/build/dist/host/terminal/startup.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../data/build/dist/shared/contracts/config.js'

// 与原生 Loader 一样更新 volatile（实时配置）引用，不引入额外持久化实现。
const require = createRequire(import.meta.url)
const { updateVolatile } = await import(pathToFileURL(require.resolve('@deepseek-ai/cosmokit', {
  paths: [require.resolve('@deepseek-ai/schemastery')],
})).href)
const namespace = '@jingyi0605/codingns4dsh'

/** 真实 SettingsForms 和插件生命周期，配置编辑仅落在测试内存中。 */
async function fixture(raw = {
  modules: { terminalEnhancement: true, assistantPanel: true },
  agentAdapters: { codex: true },
  agentAdapterPreferences: { codex: { modelId: 'saved-model' } },
  terminalEnhancement: { defaultProfile: 'bash' },
  cliSessions: [{ id: 'saved-session' }],
}) {
  const ctx = new Context()
  const entry: any = { id: 'fixture-entry', options: { id: namespace, config: raw } }
  const edits: string[] = []
  ctx.provide('loader', { await: () => Promise.resolve() })
  ctx.provide('profileContext', { home: '/nonexistent-codingns-hmr-fixture', name: 'fixture' })
  ctx.provide('configEditor', {
    documentPath: '/fixture/profile.patch.yml',
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: entry.options.config }],
    async edit(target: typeof entry, change: (config: object, inherited: object) => object) {
      edits.push(target.options.id)
      const next = change(target.options.config, {})
      target.options.config = next
      updateVolatile(target.fiber.config, CodingNsConfigSchema(next as never))
    },
  })
  const formsFiber = await ctx.plugin(SettingsForms)
  return { ctx, entry, edits, formsFiber }
}

test('原生加载态和连续 Host 重载均读取已保存的开关、偏好和会话索引', async () => {
  const { ctx, entry, formsFiber } = await fixture()
  try {
    for (let generation = 0; generation < 3; generation += 1) {
      const enabled = generation !== 1
      entry.options.config.modules.terminalEnhancement = enabled
      let injected: any
      let scope: ReturnType<typeof registerCodingNsSettings> | undefined
      let mode: string | undefined
      const plugin = {
        Config: CodingNsConfigSchema,
        apply(owner: Context) {
          injected = owner.inject(['settings'], async (inner) => {
            // 热重载依赖已就绪时，注入回调先于拥有 Config 的 Fiber 进入激活态。
            assert.equal(owner.fiber.state, 1)
            assert.deepEqual(inner.settings.describe(), [])
            scope = registerCodingNsSettings(inner, () => owner.fiber.config)
            assert.deepEqual(scope.get(), CodingNsSettingsSchema(entry.options.config))
            const terminal = await installTerminalController(inner, scope, inner.settings, {
              resolveIdentity: async () => ({ hostId: 'fixture', storeFilename: '/fixture/terminals', hostIdFilename: '/fixture/host-id' }),
              createController: (async (_ctx, options) => ({ mode: options.enhancedEnabled ? 'enhanced' : 'baseline' })) as never,
            })
            mode = terminal.mode
          })
        },
      }
      const fiber = ctx.plugin(plugin, entry.options.config)
      // 与原生 HMR 一致，创建新 Fiber 后将其挂回原配置条目。
      entry.fiber = fiber.ctx.fiber
      await fiber
      await injected
      assert.equal(mode, enabled ? 'enhanced' : 'baseline')
      assert.equal(scope!.get().agentAdapterPreferences?.codex?.modelId, 'saved-model')
      assert.equal(scope!.get().cliSessions?.[0]?.id, 'saved-session')
      await fiber.dispose()
    }
  } finally {
    await formsFiber.dispose()
  }
})

test('重载后仍通过原生 namespace 编辑设置并通知监听器', async () => {
  const { ctx, entry, edits, formsFiber } = await fixture()
  let injected: any
  let scope: ReturnType<typeof registerCodingNsSettings>
  let notifications = 0
  const plugin = {
    Config: CodingNsConfigSchema,
    apply(owner: Context) {
      injected = owner.inject(['settings'], (inner) => {
        scope = registerCodingNsSettings(inner, () => owner.fiber.config)
        scope.watch((next) => {
          notifications += 1
          assert.equal(next.modules.terminalEnhancement, true)
        })
      })
    },
  }
  const fiber = ctx.plugin(plugin, entry.options.config)
  entry.fiber = fiber.ctx.fiber
  try {
    await fiber
    await injected
    ctx.settings.describe()
    const beforeUpdate = notifications
    await scope!.update({ agentAdapters: { codex: false } })
    assert.deepEqual(edits, [namespace])
    assert.equal(entry.options.config.agentAdapters.codex, false)
    assert.equal(scope!.get().agentAdapters?.codex, false)
    assert.ok(notifications > beforeUpdate)

    // 表单暂时不可见时仍读取最新 volatile 引用，而不是最初的配置快照。
    entry.fiber = undefined
    assert.equal(scope!.get().agentAdapters?.codex, false)
    await assert.rejects(scope!.update({ modules: {} }), /设置条目尚未激活/u)
    assert.deepEqual(edits, [namespace])
  } finally {
    await fiber.dispose()
    await formsFiber.dispose()
  }
})

test('未提供入口配置的现代设置调用和旧版 register 路径保持兼容', () => {
  const saved = { ...DEFAULT_CODINGNS_SETTINGS, modules: { terminalEnhancement: true } }
  const ctx = {
    settings: { describe: () => [{ ns: namespace, value: saved, revision: 1 }] },
  } as unknown as Context
  assert.equal(registerCodingNsSettings(ctx).get(), saved)

  const legacyScope = { get: () => saved }
  const legacyCtx = {
    settings: {
      register(id: string, schema: unknown, options: unknown) {
        assert.equal(id, 'codingns')
        assert.equal(schema, CodingNsSettingsSchema)
        assert.deepEqual(options, { applies: 'live' })
        return legacyScope
      },
    },
  } as unknown as Context
  assert.equal(registerCodingNsSettings(legacyCtx, () => { throw new Error('旧版不读取入口配置') }), legacyScope)
})
