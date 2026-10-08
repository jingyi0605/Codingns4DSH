import { existsSync } from 'node:fs'

const repositoryUrl = new URL('../', import.meta.url)
const sourcePrefix = new URL('src/', repositoryUrl).href
const distPrefix = new URL('data/build/dist/', repositoryUrl).href
const testsPrefix = new URL('tests/', repositoryUrl).href

/** 源码里的 .js 引用指向编译产物；测试夹具则由 Node 原生加载对应的 TypeScript。 */
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('.') && !specifier.startsWith('file:')) return nextResolve(specifier, context)
  const url = new URL(specifier, context.parentURL)
  if (url.href.startsWith(sourcePrefix) && url.pathname.endsWith('.js')) {
    return nextResolve(distPrefix + url.href.slice(sourcePrefix.length), context)
  }
  if (url.href.startsWith(testsPrefix) && url.pathname.endsWith('.js')) {
    const candidate = new URL(url.href.replace(/\.js$/u, '.ts'))
    if (existsSync(candidate)) return nextResolve(candidate.href, context)
  }
  return nextResolve(specifier, context)
}
