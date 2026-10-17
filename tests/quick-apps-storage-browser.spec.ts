import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:https'
import { request } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, X509Certificate } from 'node:crypto'
import { build } from 'tsdown'
import { quickAppProxyFixture } from './quick-apps-proxy-fixture.js'
import { quickAppBrowser } from './quick-apps-browser-driver.js'
import { quickAppStorageKey } from '../src/shared/quick-app-browser-storage.js'

for (const secure of [false, true]) test(`browser-scoped app storage over ${secure ? 'HTTPS' : 'HTTP'} hydrates before scripts and isolates native facades`, { timeout: 60_000 }, async t => {
  const f = await quickAppProxyFixture(); t.after(f.dispose)
  let origin = f.origin
  const args: string[] = []
  if (secure) {
    const config = join(f.root, 'tls.cnf'), certFile = join(f.root, 'tls.pem'), keyFile = join(f.root, 'tls.key')
    await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Disposable ingress\n[ext]\nsubjectAltName=IP:127.0.0.1\n')
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', keyFile, '-out', certFile], { timeout: 15_000 })
    const cert = await readFile(certFile), key = await readFile(keyFile)
    const ingress = createServer({ cert, key }, (req, res) => {
      const upstream = request({ hostname: '127.0.0.1', port: new URL(f.origin).port, path: req.url, method: req.method, headers: { ...req.headers, host: new URL(f.origin).host }, agent: false }, reply => {
        res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res)
      })
      upstream.on('error', () => { res.writeHead(502).end() }); req.pipe(upstream)
    })
    await new Promise<void>(resolve => ingress.listen(0, '127.0.0.1', resolve))
    t.after(async () => { ingress.closeAllConnections(); await new Promise<void>(resolve => ingress.close(() => resolve())) })
    origin = `https://127.0.0.1:${(ingress.address() as { port: number }).port}`
    args.push(`--ignore-certificate-errors-spki-list=${createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')}`)
  }
  const browser = await quickAppBrowser(t, args); if (!browser) return
  const original = await readFile(join(f.root, 'site/proxy.html'), 'utf8')
  const startup = '<script>window.storageStartup=[localStorage.getItem("startup"),sessionStorage.getItem("draft"),document.compatMode];window.storageErrors=[];addEventListener("appstorageerror",e=>storageErrors.push(e.detail.name));</script>'
  await writeFile(join(f.root, 'site/proxy.html'), original.replace('<html lang="en">', '<html lang="en">' + startup))
  const current = f.registry.get(f.app.id)
  const appA = await f.registry.upsert({ ...current, entryPath: 'site/proxy.html' }, current.revision)
  const appB = await f.registry.upsert({ ...appA, id: '', title: 'Other app' }, 0)
  const viewA = await f.launch(origin, true)
  const viewB = await f.service.launch(appB.id, 'browser-owner', undefined, origin, true) as any
  const outDir = join(f.root, 'ui-build')
  await build({ config: false, entry: ['tests/fixtures/quick-app-storage-viewer.ts'], outDir, platform: 'browser', format: 'iife', target: 'es2022', dts: false, sourcemap: false, clean: true })
  const bundle = await readFile(join(outDir, 'quick-app-storage-viewer.iife.js'), 'utf8')
  f.setUi(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><p id="privileged">DSH</p><script>window.fixtureApps=${JSON.stringify([{ app: appA, view: viewA }, { app: appB, view: viewB }])};localStorage.setItem('dsh-private','sentinel');if(localStorage.getItem(${JSON.stringify(quickAppStorageKey(appA))})===null)localStorage.setItem(${JSON.stringify(quickAppStorageKey(appA))},JSON.stringify([['startup','restored']]));</script><script>${bundle}</script>`)
  const { command, evaluate, contexts } = browser
  await command('Page.enable'); await command('Page.navigate', { url: origin })
  const contextFor = async (url: string, previous?: number, driver = browser) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const tree = await driver.command('Page.getFrameTree')
      const child = tree.frameTree.childFrames?.find((item: any) => item.frame.url === url)
      const context = child && driver.contexts.get(child.frame.id)
      if (context && context !== previous && await driver.evaluate('!!window.fixtureReady', context).catch(() => false)) return context as number
      await new Promise(resolve => setTimeout(resolve, 75))
    }
    throw new Error('Storage fixture did not load: ' + JSON.stringify(await evaluate('({errors:window.fixtureStorageErrors,frames:[...document.querySelectorAll("iframe")].map(f=>f.src)})')))
  }
  let contextA = await contextFor(viewA.url)
  const contextB = await contextFor(viewB.url)
  assert.deepEqual(await evaluate('storageStartup', contextA), ['restored', null, 'CSS1Compat'])
  assert.deepEqual(await evaluate('storageStartup', contextB), [null, null, 'CSS1Compat'])
  assert.equal(await evaluate('document.querySelector("#result").textContent', contextA), 'module|dynamic|fetch|unicode|classic')
  assert.deepEqual(await evaluate(`(async()=>{
    localStorage.setItem('counter',1);const immediate=localStorage.getItem('counter');
    localStorage.named='property';localStorage.setItem('__proto__','safe');delete localStorage.named;
    await appStorage.flush();await appStorage.setItem('settings','A');await appStorage.session.setItem('draft','tab');
    return [immediate,localStorage.named,localStorage.getItem('__proto__'),await appStorage.getItem('settings'),await appStorage.keys(),sessionStorage.getItem('draft')];
  })()`, contextA), ['1', null, 'safe', 'A', ['startup', 'counter', '__proto__', 'settings'], 'tab'])
  assert.equal(await evaluate('appStorage.getItem("settings")', contextB), null)
  await evaluate('appStorage.setItem("settings","B")', contextB)
  assert.equal(await evaluate('appStorage.getItem("settings")', contextA), 'A')
  for (const expression of ['parent.document.body.innerText', 'document.cookie', 'indexedDB.open("fixture")']) {
    assert.equal(await evaluate(`(()=>{try{${expression};return 'accessible'}catch{return 'sandboxed'}})()`, contextA), 'sandboxed')
  }
  assert.equal(await evaluate('localStorage.getItem("dsh-private")', contextA), null)
  assert.equal(await evaluate('fetch("./__quickapp/files?path=data/member.json").then(r=>r.ok)', contextA), true)
  await evaluate(`document.getElementById(${JSON.stringify(appA.id)}).src=${JSON.stringify(viewA.url)}`)
  contextA = await contextFor(viewA.url, contextA)
  assert.deepEqual(await evaluate('storageStartup', contextA), ['restored', 'tab', 'CSS1Compat'])
  assert.equal(await evaluate('localStorage.getItem("settings")', contextA), 'A')
  const spaUrl = origin + viewA.basePath + 'virtual-route?marker=1'
  await evaluate(`document.getElementById(${JSON.stringify(appA.id)}).src=${JSON.stringify(spaUrl)}`)
  contextA = await contextFor(spaUrl)
  assert.equal(await evaluate('location.search', contextA), '?marker=1')
  assert.equal(await evaluate('localStorage.getItem("settings")', contextA), 'A')
  await evaluate(`window.nativeStorage=localStorage;Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:key=>nativeStorage.getItem(key),removeItem:key=>nativeStorage.removeItem(key),setItem(){throw new DOMException('Fixture quota exhausted','QuotaExceededError')}}});void 0`)
  assert.deepEqual(await evaluate(`(async()=>{localStorage.setItem('failed','optimistic');const immediate=localStorage.getItem('failed');let error;try{await appStorage.flush()}catch(e){error=e.name}return [immediate,error,localStorage.getItem('failed'),storageErrors]})()`, contextA), ['optimistic', 'QuotaExceededError', null, ['QuotaExceededError']])
  assert.ok((await evaluate('fixtureStorageErrors')).length > 0)
  await evaluate(`Object.defineProperty(window,'localStorage',{configurable:true,value:window.nativeStorage});void 0`)
  await f.service.launches.revoke(viewA.launchId)
  const reopened = await f.launch(origin, true)
  await evaluate(`fixtureDisposers[0]();document.getElementById(${JSON.stringify(appA.id)}).remove();fixtureOpen(${JSON.stringify({ app: appA, view: reopened })});void 0`)
  contextA = await contextFor(reopened.url)
  assert.deepEqual(await evaluate('storageStartup', contextA), ['restored', 'tab', 'CSS1Compat'])
  assert.equal(await evaluate('localStorage.getItem("settings")', contextA), 'A')
  await evaluate('appStorage.session.setItem("draft","B-tab")', contextB)
  const { targetId } = await browser.call('Target.createTarget', { url: origin, browserContextId: browser.browserContextId })
  const otherTab = await browser.attach(targetId)
  const otherContext = await contextFor(viewB.url, undefined, otherTab as typeof browser)
  assert.equal(await otherTab.evaluate('appStorage.getItem("settings")', otherContext), 'B')
  assert.equal(await otherTab.evaluate('sessionStorage.getItem("draft")', otherContext), null, 'A separate tab has independent session data')
  await evaluate('appStorage.clear()', contextA)
  assert.equal(await evaluate('appStorage.getItem("settings")', contextB), 'B')
  assert.equal(await evaluate('localStorage.getItem("dsh-private")'), 'sentinel')
  assert.equal(await evaluate('sessionStorage.getItem("draft")', contextA), 'tab')
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth', contextA), true)
  await evaluate('fixtureDisposers.at(-1)()')
  assert.equal(await evaluate('(async()=>{await new Promise(r=>setTimeout(r,25));try{await appStorage.setItem("closed","no");return "unexpected"}catch(e){return e.name}})()', contextA), 'SecurityError')
  t.diagnostic('Disposable browser profile and HTTP/HTTPS fixture only. Physical mobile and installed Desktop were not operated.')
})
