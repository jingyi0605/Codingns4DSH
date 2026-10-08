import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Rolldown } from 'tsdown'
import { CLIENT_PLUGIN_ID, clientChunkBanner, finalizeClientChunks, nativeClientChunksPlugin, transformClientChunk } from '../scripts/client-chunks.mjs'

/** 固定 CJS fixture，不调用打包器或任何构建 API。 */
function chunk(fileName: string, body: string, dynamicImports: string[] = []) {
  const output = { type: 'chunk', fileName, isEntry: fileName === 'bundle.js', dynamicImports, modules: {}, code: '', map: null }
  output.code = `${clientChunkBanner(output)}\nvar module = { exports: {} }; var exports = module.exports;\n${body}\nreturn module.exports; } });`
  return output
}

function fixture(changed = '42') {
  const list = [
    chunk('bundle.js', 'exports.shared = require("./client.shared.js"); exports.open = () => Promise.resolve().then(() => require("./client.workbench.js"));', ['client.workbench.js']),
    chunk('client.shared.js', 'exports.state = { value: 1 }; exports.react = require("react"); exports.ui = require("@deepseek-ai/dsh-client-ui-primitives"); exports.load = () => Promise.resolve().then(() => require("./client.leaf.js"));', ['client.leaf.js']),
    chunk('client.workbench.js', 'exports.shared = require("./client.shared.js"); exports.entry = require("./bundle.js");'),
    chunk('client.leaf.js', `exports.value = ${changed};`),
  ]
  const bundle: Record<string, any> = {}
  const edges = new Map<string, string[]>()
  for (const output of list) {
    const result = transformClientChunk(output.code, output)
    output.code = result.code
    edges.set(output.fileName, result.synchronous)
    bundle[output.fileName] = output
  }
  const result = finalizeClientChunks(bundle, edges)
  return { bundle, result }
}

/** 模拟原生同步工厂、模块缓存和 owner 相对加载；故意不支持相对同步 require。 */
function loader(bundle: Record<string, any>) {
  const registered = new Map<string, (require: any) => any>()
  const cache = new Map<string, any>()
  const fetching: string[] = []
  const seeds = new Map([['react', {}], ['@deepseek-ai/dsh-client-ui-primitives', {}]])
  const context = { window: { __ModuleLoader__: { load(registration: any) {
    const id = registration.id + (registration.chunk ? `/${registration.chunk}` : '')
    assert.equal(registered.has(id), false, '原生加载器拒绝重复工厂')
    registered.set(id, registration.factory)
  } } } }
  const execute = (file: string) => runInNewContext(bundle[file].code, context)
  const materialize = (id: string, owner = id) => {
    if (cache.has(id)) return cache.get(id)
    const require: any = (specifier: string) => {
      assert.ok(!specifier.startsWith('.'), `相对同步 require 落地：${specifier}`)
      if (seeds.has(specifier)) return seeds.get(specifier)
      assert.ok(registered.has(specifier), `模块未注册：${specifier}`)
      return materialize(specifier)
    }
    require.async = async (specifier: string) => {
      const file = specifier.slice(2)
      const target = `${owner}/${file}`
      assert.equal(owner, CLIENT_PLUGIN_ID, '共享工厂必须沿用插件 owner')
      if (!registered.has(target)) { fetching.push(file); execute(file) }
      return materialize(target, owner)
    }
    const value = registered.get(id)!(require)
    cache.set(id, value)
    return value
  }
  return { fetching, seeds, start() { execute('bundle.js'); return materialize(CLIENT_PLUGIN_ID) }, invalidate() { registered.clear(); cache.clear() } }
}

test('原生工厂首次只加载入口，动态组件与共享状态保持单实例并支持共享模块再动态导入', async () => {
  const { bundle, result } = fixture()
  assert.deepEqual(result.sharedNames, ['client.shared.js'])
  const runtime = loader(bundle)
  const entry = runtime.start()
  assert.deepEqual(runtime.fetching, [])
  const workbench = await entry.open()
  assert.equal(workbench.shared, entry.shared)
  assert.equal(workbench.entry, entry)
  assert.equal(workbench.shared.react, runtime.seeds.get('react'))
  assert.equal(workbench.shared.ui, runtime.seeds.get('@deepseek-ai/dsh-client-ui-primitives'))
  assert.equal((await workbench.shared.load()).value, 42)
  assert.deepEqual(runtime.fetching, ['client.workbench.js', 'client.leaf.js'])
  assert.equal(await entry.open(), workbench)
  runtime.invalidate()
  const replacement = runtime.start()
  assert.notEqual(replacement.shared, entry.shared, 'HMR 清除插件分块后能重新注册')
  assert.equal((await replacement.open()).shared, replacement.shared)
})

test('只改动态叶子也改变入口内容，更新完成后最后触碰入口供 HMR 读取', async () => {
  assert.notEqual(fixture('42').bundle['bundle.js'].code, fixture('43').bundle['bundle.js'].code)
  const directory = await mkdtemp(join(tmpdir(), 'codingns-chunk-fixture-'))
  try {
    const path = join(directory, 'bundle.js')
    await writeFile(path, 'fixture')
    const before = await stat(path)
    await nativeClientChunksPlugin().writeBundle({ dir: directory })
    assert.ok((await stat(path)).mtimeMs > before.mtimeMs)
    assert.equal(await readFile(path, 'utf8'), 'fixture')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('转换保留 CJS 命名空间包装，忽略字符串与注释里的伪 require', () => {
  const source = chunk('bundle.js', '// require("./ignored.js")\nexports.note = "require(\\\"./ignored.js\\\")"; exports.open = () => Promise.resolve().then(() => __toESM(require("./client.engine.js")));', ['client.engine.js'])
  const result = transformClientChunk(source.code, source)
  assert.match(result.code, /require\.async\("\.\/client\.engine\.js"\)\.then\(\(__codingnsChunk\) => __toESM\(__codingnsChunk\)\)/u)
  assert.deepEqual(result.synchronous, [])
  assert.match(result.code, /\/\/ require\("\.\/ignored\.js"\)/u)
})

test('renderChunk 返回可序列化的标准源码映射，不向原生桥传入空 ignoreList', () => {
  const source = chunk('bundle.js', 'exports.shared = require("./client.shared.js");')
  const result = nativeClientChunksPlugin().renderChunk(source.code, source, { format: 'cjs' })
  const map = JSON.parse(JSON.stringify(result.map))
  assert.equal(map.version, 3)
  assert.equal(typeof map.mappings, 'string')
  assert.ok(map.mappings.length > 0)
  assert.deepEqual(map.sourcesContent, [source.code])
  assert.ok(Array.isArray(map.sources))
  assert.ok(Array.isArray(map.names))
  assert.ok(map.x_google_ignoreList === undefined || Array.isArray(map.x_google_ignoreList))
  assert.notEqual(result.map.x_google_ignoreList, null, '原生桥拒绝 null 类型的 ignoreList')
  assert.match(result.code, /require\("@jingyi0605\/codingns4dsh\/client\.shared\.js"\)/u)
})

test('入口拼接读取真实原生源码映射的访问器字段，不能将映射序列化为空对象', () => {
  const entry: any = chunk('bundle.js', 'exports.value = 1;')
  const shared: any = chunk('client.shared.js', 'exports.shared = true;')
  for (const output of [entry, shared]) {
    output.map = new Rolldown.RolldownMagicString(output.code).generateMap({ source: output.fileName, hires: true })
  }
  const expectedMaps = [shared, entry].map((output) => JSON.parse(output.map.toString()))
  const emitted: any[] = []
  finalizeClientChunks({ 'bundle.js': entry, 'client.shared.js': shared }, new Map([['bundle.js', ['client.shared.js']]]), (asset: any) => emitted.push(asset))
  const indexed = JSON.parse(emitted[0].source)
  assert.deepEqual(indexed.sections.map((section: any) => section.map), expectedMaps)
  assert.equal(indexed.sections[0].offset.line, 2)
  assert.ok(indexed.sections[1].offset.line > 2)
})

test('同文件动态导入保留命名空间与异步初始化，入口和叶子都不重复下载自身', async () => {
  for (const fileName of ['bundle.js', 'client.workbench.js']) {
    const source = chunk(fileName, `
var local_exports = { value: 42 };
var initialized = false;
function init_local() { initialized = true; }
exports.state = local_exports;
exports.initialized = () => initialized;
exports.open = () => Promise.resolve().then(() => (init_local(), local_exports));
exports.namespace = () => Promise.resolve().then(() => local_exports);
`, [fileName, `./${fileName}`])
    const result = transformClientChunk(source.code, source)
    assert.equal(result.code, source.code, '同文件导入无需生成原生加载请求')
    assert.deepEqual(result.synchronous, [])
    const entry = fileName === 'bundle.js' ? source : chunk('bundle.js', 'exports.open = () => require.async("./client.workbench.js");')
    const bundle = { 'bundle.js': entry, [fileName]: source }
    finalizeClientChunks(bundle, new Map())
    const runtime = loader(bundle)
    const root = runtime.start()
    const target = fileName === 'bundle.js' ? root : await root.open()
    const fetching = [...runtime.fetching]
    const pending = target.open()
    assert.equal(target.initialized(), false, '不能提前执行动态导入的初始化')
    assert.equal(await pending, target.state)
    assert.equal(target.initialized(), true)
    assert.equal(await target.namespace(), target.state)
    assert.deepEqual(runtime.fetching, fetching, '同文件动态导入复用已有模块')
  }
})

test('同文件与跨文件动态导入共存时，仍转换并校验每个真实分块', () => {
  const source = chunk('bundle.js', 'exports.local = () => Promise.resolve().then(() => local_exports); exports.open = () => Promise.resolve().then(() => require("./client.engine.js"));', ['bundle.js', './client.engine.js'])
  const result = transformClientChunk(source.code, source)
  assert.match(result.code, /Promise\.resolve\(\)\.then\(\(\) => local_exports\)/u)
  assert.match(result.code, /require\.async\("\.\/client\.engine\.js"\)/u)
  assert.deepEqual(result.synchronous, [])
  assert.throws(() => transformClientChunk(source.code, { ...source, dynamicImports: [...source.dynamicImports, 'client.missing.js'] }), /没有可转换的导入表达式：client\.missing\.js/u)
  assert.throws(() => transformClientChunk(source.code, { ...source, dynamicImports: ['bundle.js'] }), /动态分块不在输出图中/u)
  const residual = chunk('bundle.js', 'exports.open = () => import("./bundle.js");', ['bundle.js'])
  residual.code = transformClientChunk(residual.code, residual).code
  assert.throws(() => finalizeClientChunks({ 'bundle.js': residual }, new Map()), /残留相对 import/u)
})

test('未知转换格式、非法相对路径、缺失共享块和同步循环在产物写入前失败', () => {
  assert.throws(() => transformClientChunk('require("../escape.js")', chunk('bundle.js', '')), /相对同步/u)
  assert.throws(() => transformClientChunk('require("react-dom")', chunk('bundle.js', '')), /单实例表/u)
  assert.throws(() => transformClientChunk('require(name)', chunk('bundle.js', '')), /计算式/u)
  assert.throws(() => transformClientChunk('import("./client.engine.js")', chunk('bundle.js', '', ['client.engine.js'])), /没有可转换/u)
  const entry = chunk('bundle.js', '')
  assert.throws(() => finalizeClientChunks({ 'bundle.js': entry }, new Map([['bundle.js', ['client.missing.js']]])), /缺少输出/u)
  assert.throws(() => finalizeClientChunks({ 'bundle.js': entry, 'client.shared.js': chunk('client.shared.js', '') }, new Map([
    ['bundle.js', ['client.shared.js']], ['client.shared.js', ['bundle.js']],
  ])), /同步分块循环/u)
})

test('打包配置保留 bundle.js 并注册原生分块 hook，叶子引擎不反向导入入口', async () => {
  const config = await readFile(new URL('../tsdown.config.ts', import.meta.url), 'utf8')
  assert.match(config, /entryFileNames: 'bundle\.js'/u)
  assert.match(config, /chunkFileNames: 'client\.\[name\]\.js'/u)
  assert.match(config, /nativeClientChunksPlugin\(\)/u)
  for (const path of ['../src/client/editor-engine.ts', '../src/client/terminal/xterm-engine.ts']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /from ['"]\./u)
  }
})

test('最终门禁拒绝残留相对 require 与内联 React，拼接入口保留分块 source map', () => {
  assert.throws(() => finalizeClientChunks({ 'bundle.js': chunk('bundle.js', 'require("./client.late.js")') }, new Map()), /残留相对/u)
  const duplicate: any = chunk('bundle.js', '')
  duplicate.modules = { '/project/node_modules/react/index.js': {} }
  assert.throws(() => finalizeClientChunks({ 'bundle.js': duplicate }, new Map()), /内联了单实例/u)
  const entry: any = chunk('bundle.js', '')
  const shared: any = chunk('client.shared.js', '')
  const map = { version: 3, sources: ['source.ts'], sourcesContent: ['export const value = 1'], names: [], mappings: 'AAAA' }
  entry.map = map
  shared.map = map
  const bundle: any = { 'bundle.js': entry, 'client.shared.js': shared, 'bundle.js.map': { type: 'asset', source: '' } }
  finalizeClientChunks(bundle, new Map([['bundle.js', ['client.shared.js']]]))
  const indexed = JSON.parse(bundle['bundle.js.map'].source)
  assert.equal(indexed.sections.length, 2)
  assert.equal(indexed.sections[0].offset.line, 2)
  assert.ok(indexed.sections[1].offset.line > indexed.sections[0].offset.line)
  assert.deepEqual(indexed.sections[1].map.sources, ['source.ts'])
  assert.equal(entry.map, null, '不把 indexed map 交给只支持平面结构的 Rolldown 桥接')
  assert.equal(entry.sourcemapFileName, null)
  assert.match(entry.code, /sourceMappingURL=bundle\.js\.map/u)
})

test('分块门禁保留 Live2D 运行时 URL 导入，只拒绝遗漏转换的相对模块', () => {
  assert.throws(() => finalizeClientChunks({ 'bundle.js': chunk('bundle.js', 'exports.load = () => import("./client.engine.js")') }, new Map()), /相对 import/u)
  const entry = chunk('bundle.js', 'exports.load = (url) => import(/* @vite-ignore */ url);')
  finalizeClientChunks({ 'bundle.js': entry }, new Map())
  assert.match(entry.code, /import\(\/\* @vite-ignore \*\/ url\)/u)
})

test('原生 generateBundle hook 单独输出 indexed map 资产，不依赖映射资产提前存在', () => {
  const entry: any = chunk('bundle.js', 'exports.value = 1;')
  entry.map = { version: 3, sources: ['entry.ts'], sourcesContent: ['export const value = 1'], names: [], mappings: 'AAAA' }
  entry.sourcemapFileName = 'bundle.js.map'
  const emitted: any[] = []
  nativeClientChunksPlugin().generateBundle.call({ emitFile(asset: any) { emitted.push(asset) } }, {}, { 'bundle.js': entry })
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].type, 'asset')
  assert.equal(emitted[0].fileName, 'bundle.js.map')
  const indexed = JSON.parse(emitted[0].source)
  assert.equal(indexed.sections.length, 1)
  assert.deepEqual(indexed.sections[0].map.sources, ['entry.ts'])
  assert.equal(entry.map, null)
  assert.equal(entry.sourcemapFileName, null)
})
