import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repositoryUrl = new URL('../', import.meta.url)
const distPrefix = new URL('data/build/dist/', repositoryUrl).href
const sourcePrefix = new URL('src/', repositoryUrl).href

/** 把现有测试的 dist 导入映射到源码，并解析源码中面向产物的 .js 导入。 */
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('.') && !specifier.startsWith('file:')) return nextResolve(specifier, context)
  const url = new URL(specifier, context.parentURL)
  if (url.href.startsWith(distPrefix)) url.href = sourcePrefix + url.href.slice(distPrefix.length)
  if (url.href.startsWith(sourcePrefix) && url.pathname.endsWith('.js')) {
    for (const extension of ['.ts', '.tsx']) {
      const candidate = new URL(url.href.replace(/\.js$/u, extension))
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true }
    }
  }
  return nextResolve(url.href, context)
}

/** 只转换当前加载的模块；不写产物、不清理目录、不启动服务。 */
export async function load(url, context, nextLoad) {
  if (!url.startsWith(sourcePrefix) || !/\.tsx?$/u.test(new URL(url).pathname)) return nextLoad(url, context)
  const source = await readFile(new URL(url), 'utf8')
  const output = ts.transpileModule(source, {
    fileName: fileURLToPath(url),
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
  })
  return { format: 'module', shortCircuit: true, source: output.outputText }
}
