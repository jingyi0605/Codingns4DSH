import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const name = 'codingns-stage0-client-hmr'
export const inject = ['clientModules', 'webServer']

/** 浏览器只刷新页面，不调用 modules.entries.reload，避免终端旧注册残留。 */
export const reloadScript = `(() => {
  const source = new EventSource('plugins/events');
  const packageId = '@jingyi0605/codingns4dsh';
  let revision;
  let timer;
  source.addEventListener('message', (event) => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    const next = frame.type === 'rebuilt' && frame.id === packageId
      ? frame.rev
      : frame.type === 'graph' && Array.isArray(frame.graph?.entries)
        ? frame.graph.entries.find((entry) => entry.id === packageId)?.rev
        : undefined;
    if (typeof next !== 'string' || next === revision) return;
    if (revision !== undefined || frame.type === 'rebuilt') {
      clearTimeout(timer);
      timer = setTimeout(() => { source.close(); location.reload(); }, 1000);
    }
    revision = next;
  });
  addEventListener('pagehide', () => { clearTimeout(timer); source.close(); }, { once: true });
})();`

/** 复用当前 Stage0 运行时的官方监听和 SSE（服务器发送事件）实现，不复制产物缓存逻辑。 */
export async function apply(ctx) {
  const launcher = process.env.CODINGNS4DSH_STAGE0_LAUNCHER
  if (!launcher) throw new Error('Stage0 HMR requires CODINGNS4DSH_STAGE0_LAUNCHER')
  const require = createRequire(launcher)
  const transport = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-hmr')).href)
  transport.apply(ctx, { pollIntervalMs: 500 })
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'head', text: reloadScript })
  })
}
