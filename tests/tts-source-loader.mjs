import { readFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const project = new URL('../', import.meta.url).href
export async function resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(project) && (specifier.startsWith('.') || specifier.startsWith('file:'))) {
    const candidate = new URL(specifier, context.parentURL)
    if (candidate.href.startsWith(project) && candidate.pathname.endsWith('.js')) {
      const source = new URL(candidate.href.replace('/data/build/dist/', '/src/').replace(/\.js$/u, '.ts'))
      try { await access(source); return { url: source.href, shortCircuit: true } } catch { /* 非源码文件走原生加载器 */ }
    }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url.startsWith(project) && url.endsWith('.ts')) {
    const result = ts.transpileModule(await readFile(new URL(url), 'utf8'), { fileName: fileURLToPath(url), compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } })
    return { format: 'module', source: result.outputText, shortCircuit: true }
  }
  return next(url, context)
}
