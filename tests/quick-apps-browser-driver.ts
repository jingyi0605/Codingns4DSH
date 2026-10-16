import { spawn } from 'node:child_process'
import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestContext } from 'node:test'
import WebSocket from 'ws'

export async function quickAppBrowser(t: TestContext, args: string[] = []) {
  let executable = process.env.QUICK_APPS_BROWSER_BIN
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  if (!executable) for (const entry of (await readdir(cache).catch(() => [])).sort().reverse()) {
    if (!entry.startsWith('chromium_headless_shell-')) continue
    const candidate = join(cache, entry, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')
    try { await access(candidate); executable = candidate; break } catch { /* Keep looking. */ }
  }
  if (!executable) { t.skip('Set QUICK_APPS_BROWSER_BIN; this test does not install a browser.'); return undefined }
  const profile = await mkdtemp(join(tmpdir(), 'quick-app-browser-'))
  const browser = spawn(executable, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--no-proxy-server', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  t.after(async () => {
    if (browser.exitCode === null) { const exit = new Promise<void>(resolve => browser.once('exit', () => resolve())); browser.kill('SIGTERM'); await exit }
    await rm(profile, { recursive: true, force: true })
  })
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Browser startup timed out')), 10_000)
    let output = ''
    browser.stderr.on('data', chunk => { output += String(chunk); const match = output.match(/DevTools listening on (ws:\/\/\S+)/u); if (match) { clearTimeout(timeout); resolve(match[1]!) } })
    browser.once('error', reject); browser.once('exit', () => { clearTimeout(timeout); reject(new Error('Browser exited early')) })
  })
  const socket = new WebSocket(endpoint)
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  t.after(() => socket.close())
  let sequence = 0
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }>()
  socket.on('message', bytes => {
    const value = JSON.parse(String(bytes)); const item = pending.get(value.id)
    if (!item) return
    clearTimeout(item.timeout); pending.delete(value.id)
    if (value.error) item.reject(new Error(JSON.stringify(value.error))); else item.resolve(value.result)
  })
  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 10_000)
    pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const attach = async (targetId: string) => {
    const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true })
    const command = (method: string, params: Record<string, unknown> = {}) => call(method, params, sessionId)
    const contexts = new Map<string, number>()
    const onContext = (bytes: WebSocket.RawData) => {
      const event = JSON.parse(String(bytes))
      if (event.sessionId !== sessionId) return
      if (event.method === 'Runtime.executionContextsCleared') contexts.clear()
      const context = event.params?.context
      if (event.method === 'Runtime.executionContextCreated' && context.auxData?.isDefault) contexts.set(context.auxData.frameId, context.id)
    }
    socket.on('message', onContext); t.after(() => socket.off('message', onContext))
    await command('Runtime.enable')
    const evaluate = async (expression: string, contextId?: number) => {
      const result = await command('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    return { command, evaluate, contexts }
  }
  // Headless shell can retain system proxy settings despite command-line flags.
  // This disposable context connects only to our loopback-mapped fixture names.
  const { browserContextId } = await call('Target.createBrowserContext', { proxyServer: 'direct://', proxyBypassList: '*' })
  const { targetId } = await call('Target.createTarget', { url: 'about:blank', browserContextId })
  return { call, attach, browserContextId, ...(await attach(targetId)) }
}
