import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

const SIDEBAR_MODULE = '@deepseek-ai/dsh-client-ui-sidebar-right'
const COMPAT_ROUTE = '/__codingns/sidebar-session-v1'
const VIEW_START = 'var SidebarSessionView = class {'
const OPENING_HANDLER = /this\.reference\.ready\.catch\(\(error\) => \{\r?\n([\t ]*)console\.error\("Sidebar Session opening failed:", error\);\r?\n[\t ]*\}\);/u

interface ClientModules {
  fetchBundle(request: Request): Promise<Response>
}

interface WebServer {
  register(route: {
    kind: 'prefix'
    path: string
    handler(request: IncomingMessage, response: ServerResponse): Promise<void>
  }): () => void
}

/**
 * 需要该补丁的 DSH 版本：alpha.1 与 alpha.2 的侧栏都会把自身 dispose 引起的
 * ready 拒绝当作打开失败（已逐字节核对两版 `client.js` 的目标回调完全一致，
 * 且都缺少 `disposed` 守卫）。上游修复后从该集合移除并删除本文件。
 */
const SIDEBAR_SESSION_COMPAT_VERSIONS = new Set(['0.2.1-alpha.1', '0.2.1-alpha.2'])

/**
 * DSH 0.2.1-alpha.1 / alpha.2 的侧栏会把自身 dispose 引起的 ready 拒绝当作打开失败。
 * 只在原生视图的回调里检查所有权；不改 Promise 的拒绝语义、引用计数或 console。
 * 匹配限定到已核对的类和回调，未知上游产物原样返回。保持行数，避免后续源码映射偏移。
 */
export function patchSidebarSessionBundle(source: string): string {
  const start = source.indexOf(VIEW_START)
  if (start < 0) return source
  const end = source.indexOf('//#endregion', start)
  if (end < 0) return source
  const view = source.slice(start, end)
  const patched = view.replace(OPENING_HANDLER, (handler: string) => handler.replace(
    'console.error("Sidebar Session opening failed:", error);',
    'if (!this.disposed) console.error("Sidebar Session opening failed:", error);',
  ))
  return source.slice(0, start) + patched + source.slice(end)
}

/** 新路径区分原生 immutable 缓存；保留文档相对路径，兼容反代子目录。 */
function rewriteBundleUrl(url: unknown): unknown {
  if (typeof url !== 'string' || !/^\/?plugins\/\?\?/u.test(url)) return url
  if (!url.includes(`${SIDEBAR_MODULE}/client.js`)) return url
  const prefix = url.startsWith('/') ? COMPAT_ROUTE : COMPAT_ROUTE.slice(1)
  return `${prefix}/${url.replace(/^\//u, '')}`
}

function rewriteDescriptor(value: unknown): unknown {
  if (!isRecord(value)) return value
  const url = rewriteBundleUrl(value.url)
  return url === value.url ? value : { ...value, url }
}

/** 同时改写预加载、初始批次和单模块回退地址，不修改 ClientModuleRegistry 的共享图。 */
export function injectSidebarSessionCompat(table: unknown[]): void {
  for (let index = 0; index < table.length; index += 1) {
    const row = table[index]
    if (!isRecord(row)) continue
    if (row.kind === 'script-preload' || row.kind === 'script-src') {
      const src = rewriteBundleUrl(row.src)
      if (src !== row.src) table[index] = { ...row, src }
      continue
    }
    if (row.kind !== 'global' || row.name !== '__DSH_BOOT__' || !isRecord(row.value)) continue
    const graph = row.value
    if (!Array.isArray(graph.entries) || !Array.isArray(graph.batches)) continue
    table[index] = { ...row, value: {
      ...graph,
      entries: graph.entries.map(rewriteDescriptor),
      batches: graph.batches.map(rewriteDescriptor),
    } }
  }
}

/**
 * 复用官方只读资源接口，不读取或写入运行时安装目录。map 和非 JS 响应直接透传；
 * 新地址下的相对 sourceMappingURL 仍落到此路由，并还原为同一原生资源。
 */
export async function fetchSidebarSessionBundle(
  modules: ClientModules,
  request: { method?: string | undefined; url?: string | undefined },
): Promise<Response> {
  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') return new Response(null, { status: 405 })
  const url = request.url ?? ''
  if (!url.startsWith(`${COMPAT_ROUTE}/plugins/`)) return new Response(null, { status: 404 })
  const original = await modules.fetchBundle(new Request(`http://dsh.invalid${url.slice(COMPAT_ROUTE.length)}`, { method }))
  if (method === 'HEAD' || original.status !== 200 || !original.headers.get('content-type')?.includes('javascript')) return original
  const source = await original.text()
  const patched = patchSidebarSessionBundle(source)
  const headers = new Headers(original.headers)
  // 补丁后的长度和内容标识由新 URL 确定，不能沿用原始实体的校验头。
  headers.delete('content-length')
  headers.delete('etag')
  return new Response(patched, { status: original.status, headers })
}

/**
 * 兼容只注册在提供 WebServer 的 Host 上，并限定到已核对的上游版本。
 * 注入依赖确保原生启动图先进入表，再改写这一份页面快照；销毁时注销路由与监听。
 * 上游修复 SidebarSessionView 后可删除本文件及 Host 入口的一处注册。
 */
export function installSidebarSessionCompat(ctx: Context, dshVersion: string): void {
  if (!SIDEBAR_SESSION_COMPAT_VERSIONS.has(dshVersion)) return
  const services = ctx as unknown as { clientModules: ClientModules; webServer: WebServer }
  if (typeof services.clientModules?.fetchBundle !== 'function' || typeof services.webServer?.register !== 'function') return
  const { clientModules, webServer } = services
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: COMPAT_ROUTE,
    async handler(request, response) {
      const result = await fetchSidebarSessionBundle(clientModules, request)
      response.writeHead(result.status, Object.fromEntries(result.headers))
      response.end(result.body === null ? undefined : Buffer.from(await result.arrayBuffer()))
    },
  }), 'codingns4dsh: 侧栏会话释放兼容资源')
  const events = ctx as unknown as { on(name: string, listener: (table: unknown[]) => void): unknown }
  events.on('webserver/index-inject', injectSidebarSessionCompat)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
