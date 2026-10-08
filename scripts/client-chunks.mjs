import { createHash } from 'node:crypto'
import { stat, utimes } from 'node:fs/promises'
import { resolve } from 'node:path'
import ts from 'typescript'
import { Rolldown } from 'tsdown'

export const CLIENT_PLUGIN_ID = '@jingyi0605/codingns4dsh'
export const CLIENT_CHUNK_PATTERN = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u
const FACTORY = 'factory: (require) => {'
const EXTERNALS = new Set(['react', '@deepseek-ai/dsh-client-ui-primitives'])

/** 入口保持 bundle.js，分块使用同一个插件 ID 和原生 chunk 字段注册。 */
export function clientChunkBanner(chunk) {
  return `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_PLUGIN_ID)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}${FACTORY}`
}

/** 只识别真实调用节点；字符串、注释里的 require 不得被误改。 */
function requiredSpecifier(node) {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'require') return
  const argument = node.arguments[0]
  if (node.arguments.length !== 1 || !argument || !ts.isStringLiteralLike(argument)) {
    throw new Error('客户端分块不允许计算式 require；请使用静态 import 或明确的动态 import')
  }
  return argument.text
}

function isPromiseImport(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'then') return false
  const promise = node.expression.expression
  return ts.isCallExpression(promise) && promise.arguments.length === 0
    && ts.isPropertyAccessExpression(promise.expression) && promise.expression.name.text === 'resolve'
    && ts.isIdentifier(promise.expression.expression) && promise.expression.expression.text === 'Promise'
}

/** 原生映射使用访问器并返回 null 可选字段，按其 JSON 格式转成桥接层接受的普通对象。 */
function sourceMapObject(map) {
  const json = typeof map.toString === 'function' && map.toString !== Object.prototype.toString
    ? map.toString()
    : JSON.stringify(map)
  return JSON.parse(json)
}

/** 将 Rolldown 的 CJS 动态导入转为原生 require.async，并登记同步共享依赖。 */
export function transformClientChunk(code, chunk) {
  const source = ts.createSourceFile(chunk.fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const transformed = new Rolldown.RolldownMagicString(code)
  const synchronous = new Set()
  const dynamic = new Set()
  // Rolldown 的导入图可能包含当前分块自身；同文件动态导入已变成
  // Promise.resolve().then(() => namespace)，无需下载，也没有 require 可转换。
  // 只校验跨文件边；保留原表达式的异步初始化及模块单实例语义。
  const expectedDynamic = new Set(chunk.dynamicImports
    .map((name) => name.replace(/^\.\//u, ''))
    .filter((name) => name !== chunk.fileName))
  const visit = (node) => {
    if (isPromiseImport(node)) {
      const callback = node.arguments[0]
      if (callback && ts.isArrowFunction(callback) && !ts.isBlock(callback.body)) {
        const calls = []
        const collect = (child) => {
          const specifier = requiredSpecifier(child)
          if (specifier?.startsWith('./')) calls.push({ node: child, specifier })
          ts.forEachChild(child, collect)
        }
        collect(callback.body)
        if (calls.length === 1) {
          const imported = calls[0]
          const name = imported.specifier.slice(2)
          if (!CLIENT_CHUNK_PATTERN.test(name) || !expectedDynamic.has(name)) throw new Error(`动态分块不在输出图中：${name}`)
          dynamic.add(name)
          let expression = `require.async(${JSON.stringify(imported.specifier)})`
          // CJS 依赖有时包一层 __toESM；保留命名空间适配，不能直接丢弃。
          if (callback.body !== imported.node) {
            const body = code.slice(callback.body.getStart(source), imported.node.getStart(source))
              + '__codingnsChunk' + code.slice(imported.node.end, callback.body.end)
            expression += `.then((__codingnsChunk) => ${body})`
          }
          transformed.overwrite(node.getStart(source), node.end, expression)
          return
        }
      }
    }
    const specifier = requiredSpecifier(node)
    if (specifier?.startsWith('.')) {
      const name = specifier.slice(2)
      if (!specifier.startsWith('./') || !(name === 'bundle.js' || CLIENT_CHUNK_PATTERN.test(name))) {
        throw new Error(`客户端不支持相对同步 require：${specifier}`)
      }
      synchronous.add(name)
      const moduleId = name === 'bundle.js' ? CLIENT_PLUGIN_ID : `${CLIENT_PLUGIN_ID}/${name}`
      transformed.overwrite(node.getStart(source), node.end, `require(${JSON.stringify(moduleId)})`)
    } else if (specifier !== undefined && !EXTERNALS.has(specifier)) {
      throw new Error(`客户端外部依赖未列入原生单实例表：${specifier}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const name of expectedDynamic) {
    if (!dynamic.has(name)) throw new Error(`动态分块没有可转换的导入表达式：${name}`)
  }
  return { code: transformed.toString(), map: sourceMapObject(transformed.generateMap({ hires: true })), synchronous: [...synchronous] }
}

/** 同步工厂不支持半成品 exports；循环依赖必须在写产物前报错。 */
function assertAcyclic(chunks, edges) {
  const visited = new Set()
  const visit = (name, stack) => {
    if (stack.includes(name)) throw new Error(`客户端同步分块循环：${[...stack, name].join(' -> ')}`)
    if (visited.has(name)) return
    if (!chunks.has(name)) throw new Error(`同步分块缺少输出：${name}`)
    for (const dependency of edges.get(name) ?? []) visit(dependency, [...stack, name])
    visited.add(name)
  }
  for (const name of chunks.keys()) visit(name, [])
}

/** 最后一道产物检查：不让后续插件重新引入浏览器无法执行的导入。 */
function assertNativeRequires(chunk) {
  const source = ts.createSourceFile(chunk.fileName, chunk.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      // Live2D 使用运行时 HTTP 地址加载独立 ESM，这是原有合法路径。
      // 这里只拒绝本应交给原生分块加载器处理的相对模块，不能封禁 import(url)。
      if (argument && ts.isStringLiteralLike(argument) && argument.text.startsWith('.')) {
        throw new Error(`客户端仍残留相对 import 表达式：${chunk.fileName}`)
      }
    }
    const specifier = requiredSpecifier(node)
    if (specifier?.startsWith('.')) throw new Error(`客户端仍残留相对同步 require：${chunk.fileName}: ${specifier}`)
    ts.forEachChild(node, visit)
  }
  visit(source)
}

/**
 * DSH 的同步 require 只查模块表，不下载兄弟文件。
 * 将所有被同步引用的工厂注册放到入口，重写后的绝对 ID 仍由原生表缓存一次。
 * 工厂闭包使用入口的 require，确保共享模块里的动态导入也归属同一个插件。
 * 只有共享代码的字节进入首包，纯动态叶子仍独立下载；避免复制 React 或应用状态。
 */
export function finalizeClientChunks(bundle, edges, emitFile) {
  const chunks = new Map(Object.values(bundle).filter((output) => output.type === 'chunk').map((chunk) => [chunk.fileName, chunk]))
  const entry = chunks.get('bundle.js')
  if (!entry?.isEntry) throw new Error('客户端入口必须是 bundle.js')
  for (const chunk of chunks.values()) {
    assertNativeRequires(chunk)
    if (!chunk.isEntry && !CLIENT_CHUNK_PATTERN.test(chunk.fileName)) throw new Error(`非法客户端分块名：${chunk.fileName}`)
    // 同一插件只准保留宿主提供的 React 和 UI 原语实例。
    if (Object.keys(chunk.modules ?? {}).some((id) => /node_modules[\\/](?:react[\\/]|@deepseek-ai[\\/]dsh-client-ui-primitives[\\/])/u.test(id))) {
      throw new Error(`客户端分块内联了单实例依赖：${chunk.fileName}`)
    }
  }
  assertAcyclic(chunks, edges)
  const sharedNames = [...new Set([...edges.values()].flat())].filter((name) => name !== entry.fileName).sort()
  const sections = []
  let code = '(() => {\nlet __codingnsOwnerRequire;\n'
  const append = (chunk, body) => {
    if (chunk.map) sections.push({ offset: { line: code.split('\n').length - 1, column: 0 }, map: sourceMapObject(chunk.map) })
    code += body.replace(/\n\/\/# sourceMappingURL=[^\n]*/gu, '') + '\n'
  }
  for (const name of sharedNames) {
    const chunk = chunks.get(name)
    if (!chunk.code.includes(FACTORY)) throw new Error(`分块没有原生工厂注册：${name}`)
    append(chunk, chunk.code.replace(FACTORY, 'factory: () => { const require = __codingnsOwnerRequire;'))
  }
  // 在入口代码运行前绑定，入口静态 require 与以后到达的动态分块共用原生缓存。
  append(entry, entry.code.replace(FACTORY, `${FACTORY} __codingnsOwnerRequire = require;`))
  const revision = createHash('sha256')
  for (const [name, chunk] of [...chunks].sort(([a], [b]) => a.localeCompare(b))) revision.update(name).update('\0').update(chunk.code)
  entry.code = `${code}})();\n// codingns-client-revision: ${revision.digest('hex')}\n`
  if (sections.length) {
    // 拼接后用 indexed source map 保留每个工厂的源码位置，不沿用失效的入口行号。
    const map = { version: 3, file: entry.fileName, sections }
    const fileName = `${entry.fileName}.map`
    const source = JSON.stringify(map)
    // Rolldown 的 map 对象桥接只接受平面映射，会丢弃 sections。
    // 取消自动输出入口映射，改以原样 JSON 资产输出；分块本身的映射不变。
    entry.map = null
    entry.sourcemapFileName = null
    if (bundle[fileName]) bundle[fileName].source = source
    else {
      if (!emitFile) throw new Error('拼接源码映射需要 emitFile 资产输出接口')
      emitFile({ type: 'asset', fileName, source })
    }
    entry.code += `//# sourceMappingURL=${fileName}\n`
  }
  return { sharedNames }
}

/** 纯 hook 插件；导入本脚本不会启动构建。 */
export function nativeClientChunksPlugin() {
  const edges = new Map()
  return {
    name: 'codingns4dsh:native-client-chunks',
    buildStart() { edges.clear() },
    renderChunk(code, chunk, options) {
      if (options.format !== 'cjs') throw new Error('原生客户端分块必须使用 CJS')
      const result = transformClientChunk(code, chunk)
      edges.set(chunk.fileName, result.synchronous)
      return { code: result.code, map: result.map }
    },
    generateBundle(_options, bundle) { finalizeClientChunks(bundle, edges, (asset) => this.emitFile(asset)) },
    async writeBundle(options) {
      if (!options.dir) return
      // Host 用入口版本/mtime 通知 HMR；所有分块写完后最后触碰入口，避免只改叶子时漏刷新。
      const path = resolve(options.dir, 'bundle.js')
      const current = await stat(path)
      await utimes(path, current.atime, new Date(Math.max(Date.now(), current.mtimeMs + 1)))
    },
  }
}
