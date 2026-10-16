import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readdir, rm, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { quickAppFixture } from './quick-apps-fixture.js'

async function browserExecutable(): Promise<string | undefined> {
  if (process.env.QUICK_APPS_BROWSER_BIN) return process.env.QUICK_APPS_BROWSER_BIN
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  for (const entry of (await readdir(cache).catch(() => [])).sort().reverse()) {
    if (!entry.startsWith('chromium_headless_shell-')) continue
    const executable = join(cache, entry, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')
    try { await access(executable); return executable } catch { /* Try the next cached browser. */ }
  }
  return undefined
}

test('unchanged multi-file app in a real browser: modules, assets, isolated origins, writes and revocation', { timeout: 45_000 }, async t => {
  const executable = await browserExecutable()
  if (!executable) { t.skip('Set QUICK_APPS_BROWSER_BIN to a Chromium headless executable. No browser is installed by this test.'); return }
  const f = await quickAppFixture(); t.after(f.dispose)
  const ui = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<div id="privileged">UI</div><iframe id="app" sandbox="allow-scripts allow-same-origin" src="${f.connections[0]?.origin}/index.html"></iframe>`) })
  await new Promise<void>(resolve => ui.listen(0, '127.0.0.1', resolve))
  const uiOrigin = `http://dsh.localhost:${(ui.address() as { port: number }).port}`
  f.setUiOrigin(uiOrigin)
  t.after(async () => { ui.closeAllConnections(); await new Promise<void>(resolve => ui.close(() => resolve())) })
  await f.service.grant(f.app.id, 1, { read: ['data'], write: ['data'], delete: ['data'] })
  await f.launch(); await f.launch()
  const profile = await mkdtemp(join(tmpdir(), 'quick-app-browser-'))
  const browser = spawn(executable, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--no-proxy-server', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  t.after(async () => {
    if (browser.exitCode === null) { const exited = new Promise<void>(resolve => browser.once('exit', () => resolve())); browser.kill('SIGTERM'); await exited }
    await rm(profile, { recursive: true, force: true })
  })
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Browser startup timed out')), 10_000)
    let output = ''
    browser.stderr.on('data', chunk => { output += String(chunk); const match = output.match(/DevTools listening on (ws:\/\/\S+)/u); if (match) { clearTimeout(timeout); resolve(match[1]!) } })
    browser.once('error', reject)
    browser.once('exit', () => { clearTimeout(timeout); reject(new Error('Browser exited before its debugging endpoint was ready')) })
  })
  const socket = new WebSocket(endpoint)
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  t.after(() => socket.close())
  let requestId = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  socket.on('message', bytes => {
    const message = JSON.parse(String(bytes))
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    if (message.error) item.reject(new Error(JSON.stringify(message.error)))
    else item.resolve(message.result)
  })
  const call = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    const id = ++requestId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const target = await call('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const command = (method: string, params: Record<string, unknown> = {}) => call(method, params, sessionId)
  await command('Network.enable')
  await command('Page.enable')
  // App-only host cookies are supplied by the harness, NOT a verified production bootstrap.
  for (const connection of f.connections) await command('Network.setCookie', { name: 'quickapp', value: connection.cookie.slice('quickapp='.length), url: connection.origin, path: '/', httpOnly: true, sameSite: 'Lax' })
  const evaluate = async (expression: string) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const ready = () => evaluate('new Promise((resolve, reject) => { const end = Date.now()+8000; const check = () => window.fixtureReady ? resolve(true) : Date.now()>end ? reject(new Error("Fixture not ready: "+document.body.innerText)) : setTimeout(check, 20); check() })')
  await command('Page.navigate', { url: `${f.connections[0].origin}/index.html` }); await ready()
  assert.deepEqual(await evaluate('({ result: document.querySelector("#result").textContent, color: getComputedStyle(document.body).color, image: document.querySelector("img").naturalWidth, font: document.fonts.check("16px FixtureFont"), cookie: document.cookie })'),
    { result: 'module|dynamic|fetch|unicode|classic', color: 'rgb(20, 40, 60)', image: 1, font: true, cookie: '' })
  const other = JSON.stringify(`${f.connections[1].origin}/data.json`)
  assert.equal(await evaluate(`fetch(${other}, { credentials: 'include' }).then(() => 'leaked', () => 'blocked')`), 'blocked')
  assert.equal(await evaluate(`fetch(${JSON.stringify(uiOrigin)}, { credentials: 'include' }).then(() => 'leaked', () => 'blocked')`), 'blocked')
  const result = await evaluate(`(async () => {
    const path = '/__quickapp/files?path=data/member.json';
    const current = await fetch(path).then(r => r.json());
    const save = () => fetch(path, { method: 'PUT', headers: { 'Content-Type': 'text/plain', 'If-Match': current.version }, body: 'browser saved' });
    const first = await save(); const stale = await save();
    const staleDelete = await fetch(path, { method: 'DELETE', headers: { 'If-Match': current.version } });
    return [first.status, stale.status, staleDelete.status];
  })()`)
  assert.deepEqual(result, [200, 412, 412])
  assert.equal(await readFile(join(f.root, 'data/member.json'), 'utf8'), 'browser saved')
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
  // An actual separate UI origin embeds the application; cookies were pre-provisioned above.
  await command('Page.navigate', { url: uiOrigin })
  await evaluate('new Promise(resolve => setTimeout(resolve, 500))')
  assert.equal(await evaluate('(() => { try { document.querySelector("iframe").contentWindow.document.body; return "leaked" } catch { return "blocked" } })()'), 'blocked')
  await command('Page.navigate', { url: `${f.connections[0].origin}/index.html` }); await ready()
  await f.service.invalidate(f.app.id)
  assert.equal(await evaluate('fetch("/data.json", { cache: "no-store" }).then(r => r.ok ? "leaked" : "denied", () => "denied")'), 'denied')
  assert.ok(f.connections.every(connection => connection.closed))
  t.diagnostic(`Browser: ${executable}; local HTTP only; 390px emulation is not actual phone verification; cookies supplied by fixture.`)
})
