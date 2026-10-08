import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 用法：node scripts/check-assistant-package.mjs <已解压的插件包目录> [DSH版本]
// 只回放指定包的接口与图片读取，不启动 DSH、不安装依赖、不接触用户配置。
// 对话存储与设置均为内存夹具；模型目录也使用假服务，不调用真实模型。
const root = await realpath(resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url))))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(manifest.name, '@jingyi0605/codingns4dsh', '目标必须是 CodingNS 插件包目录')
// 默认验证包声明的最低版本，不能只在开发时的最新版上通过校验。
const dshVersion = process.argv[3] ?? manifest.engines?.dsh?.match(/^>=([^ ]+)/u)?.[1]
assert.ok(dshVersion, '包未声明最低 DSH 版本，请显式传入待验证版本')
process.env.CODINGNS4DSH_VOICE_DIAGNOSTICS = '0'
const readModule = (path) => import(pathToFileURL(join(root, 'data/build/dist', path)).href)
const [{ FeatureRegistry }, { CodingNsRpcTable }, { createCodingNsRpcHandler }, { createGlobalVoiceRpcFeature },
  { createAssistantAvatarRouteHandler, registerAssistantAvatarRoutes }, { DEFAULT_CODINGNS_SETTINGS }, { BUILTIN_ASSISTANT_AVATAR_SOURCES }] = await Promise.all([
  readModule('features/registry.js'), readModule('host/rpc-table.js'), readModule('host/rpc.js'), readModule('host/features/global-voice-rpc.js'),
  readModule('host/features/assistant-avatar-runtime.js'), readModule('shared/contracts/config.js'), readModule('shared/assistant-avatar.js'),
])
const packageReference = createRequire(join(root, 'package.json')).resolve(`${manifest.name}/package.json`)
assert.equal(await realpath(dirname(packageReference)), root, '包自引用必须指向被检查的包，不能读取另一份安装')
const settings = structuredClone(DEFAULT_CODINGNS_SETTINGS)
const rpc = new CodingNsRpcTable()
const model = { provider: 'smoke', model: 'memory', label: '内存测试模型' }
const services = {
  rpc, dshVersion, settingsProvider: { writable: true },
  settings: { get: () => settings, watch: () => () => {}, update: async () => assert.fail('只读校验不应保存设置') },
  dshContext: { get(name) {
    if (name === 'llm') return { listProviders: () => [{ id: model.provider, name: '内存测试' }], listModels: async () => [{ id: model.model, name: '测试模型' }], stream: () => assert.fail('校验不应调用模型') }
    if (name === 'agentDefaultModel') return { currentSelection: () => model }
    return undefined
  } },
}
const registry = new FeatureRegistry(services)
registry.register(createGlobalVoiceRpcFeature({
  conversationStorage: { read: async () => undefined, write: async () => assert.fail('只读校验不应保存对话') },
  conversationAdapter: { catalog: async () => ({ models: [model], default: model, errors: [] }), reply: async () => assert.fail('校验不应调用模型') },
}))
const checks = {}
try {
  await registry.reconcile(['globalVoiceRpc'])
  const handler = createCodingNsRpcHandler(rpc)
  const call = async (endpoint) => {
    const result = await handler(endpoint, {}, AbortSignal.timeout(10_000))
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.value
  }
  const lifecycle = await call('assistant/lifecycle/read')
  assert.equal(lifecycle.profile.initialized, false)
  assert.deepEqual(lifecycle.conversation.messages, [])
  checks.lifecycle = 'passed'
  const catalog = await call('assistant/chat/models')
  assert.ok(catalog.models.some((entry) => entry.model === model.model), `DSH ${dshVersion} 模型目录不可用：${JSON.stringify(catalog)}`)
  checks.models = 'passed'
  const routes = new Map()
  const dispose = registerAssistantAvatarRoutes({ register(route) {
    routes.set(route.path, route.fetch)
    return async () => { routes.delete(route.path) }
  } }, createAssistantAvatarRouteHandler())
  try {
    for (const path of Object.values(BUILTIN_ASSISTANT_AVATAR_SOURCES)) {
      assert.ok(routes.has(path), `图片路由未登记：${path}`)
      const response = await routes.get(path)(new Request(`http://package-check.invalid${path}`))
      assert.equal(response.status, 200, `图片读取失败：${path}`)
      assert.equal(response.headers.get('content-type'), 'image/png')
      const bytes = Buffer.from(await response.arrayBuffer())
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      checks[path] = { status: response.status, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
  } finally { await dispose() }
} finally { await registry.reconcile([]) }
const fingerprints = {}
for (const path of ['host/features/global-voice-rpc.js', 'client/bundle.js']) {
  fingerprints[path] = createHash('sha256').update(await readFile(join(root, 'data/build/dist', path))).digest('hex')
}
console.log(JSON.stringify({ root, version: manifest.version, dshVersion, packageReference, platform: process.platform, checks, fingerprints }, null, 2))
