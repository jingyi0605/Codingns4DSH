import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:https'
import { request } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, X509Certificate } from 'node:crypto'
import { quickAppProxyFixture } from './quick-apps-proxy-fixture.js'
import { quickAppBrowser } from './quick-apps-browser-driver.js'

for (const secure of [false, true]) test(`sandboxed Host proxy over ${secure ? 'existing HTTPS ingress' : 'HTTP'} loads resources and saves in Chromium`, { timeout: 45_000 }, async t => {
  const f = await quickAppProxyFixture(); t.after(f.dispose)
  let origin = f.origin
  const browserArgs: string[] = []
  if (secure) {
    const config = join(f.root, 'ingress.cnf'); const certFile = join(f.root, 'ingress.pem'); const keyFile = join(f.root, 'ingress.key')
    await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Disposable existing ingress\n[ext]\nsubjectAltName=IP:127.0.0.1\n')
    await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', keyFile, '-out', certFile], { timeout: 15_000 })
    const cert = await readFile(certFile); const key = await readFile(keyFile)
    const ingress = createServer({ cert, key }, (req, res) => {
      const upstream = request({ hostname: '127.0.0.1', port: new URL(f.origin).port, path: req.url, method: req.method, headers: { ...req.headers, host: new URL(f.origin).host }, agent: false }, reply => {
        res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res)
      })
      upstream.on('error', () => { res.writeHead(502).end() }); req.pipe(upstream)
    })
    await new Promise<void>(resolve => ingress.listen(0, '127.0.0.1', resolve))
    t.after(async () => { ingress.closeAllConnections(); await new Promise<void>(resolve => ingress.close(() => resolve())) })
    origin = `https://127.0.0.1:${(ingress.address() as { port: number }).port}`
    const spki = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64')
    browserArgs.push(`--ignore-certificate-errors-spki-list=${spki}`)
  }
  const current = f.registry.get(f.app.id)
  await f.registry.upsert({ ...current, entryPath: 'site/proxy.html' }, current.revision)
  const app = await f.launch(origin)
  f.setUi(`<meta name="viewport" content="width=device-width,initial-scale=1"><p id="privileged">DSH</p><iframe id="app" style="width:95%;height:600px" sandbox="allow-scripts allow-forms allow-downloads" src="${app.url}"></iframe>`)
  const servedHtml = await (await fetch(f.hostOrigin + app.basePath + 'proxy.html')).text()
  const originalHtml = await readFile(join(f.root, 'site/proxy.html'), 'utf8')
  const bootstrapStart = servedHtml.indexOf('<script>')
  const bootstrapEnd = servedHtml.indexOf('quickAppNetworkInstall();</script>', bootstrapStart)
  assert.ok(servedHtml.startsWith('<!doctype html>'), 'The doctype must remain first to preserve standards mode')
  assert.ok(bootstrapStart > 0 && bootstrapEnd > bootstrapStart, 'The egress bootstrap must be injected')
  assert.equal(servedHtml.slice(0, bootstrapStart) + servedHtml.slice(bootstrapEnd + 'quickAppNetworkInstall();</script>'.length), originalHtml, 'Only the egress bootstrap is injected')
  const browser = await quickAppBrowser(t, browserArgs); if (!browser) return
  const { command, evaluate, contexts } = browser
  await command('Page.enable'); await command('Network.enable')
  await command('Page.navigate', { url: origin })
  let context: number | undefined
  for (let attempt = 0; attempt < 80; attempt++) {
    const tree = await command('Page.getFrameTree')
    const frame = tree.frameTree.childFrames?.find((child: any) => child.frame.url === app.url)
    context = frame && contexts.get(frame.frame.id)
    if (context && await evaluate('!!window.fixtureReady', context)) break
    context = undefined; await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(context, 'Same-address sandbox loaded modules, dynamic imports and fetch without injected code')
  assert.deepEqual(await evaluate('({ mode: document.compatMode, language: document.documentElement.lang })', context), { mode: 'CSS1Compat', language: 'en' })
  assert.deepEqual(await evaluate('({result:document.querySelector("#result").textContent,color:getComputedStyle(document.body).color,image:document.querySelector("img").naturalWidth,font:document.fonts.check("16px FixtureFont")})', context),
    { result: 'module|dynamic|fetch|unicode|classic', color: 'rgb(20, 40, 60)', image: 1, font: true })
  for (const expression of ['parent.document.body.innerText', 'document.cookie', 'localStorage.length', 'indexedDB.open("fixture")']) {
    assert.equal(await evaluate(`(()=>{try{${expression};return 'accessible'}catch{return 'sandboxed'}})()`, context), 'sandboxed')
  }
  const result = await evaluate(`(async()=>{
    const path='./__quickapp/files?path=data/proxy.txt';
    const create=await fetch(path,{method:'PUT',headers:{'Content-Type':'text/plain','If-None-Match':'*'},body:'created'});
    const version=(await create.json()).version;
    const headers={'Content-Type':'text/plain','If-Match':version};
    const update=await fetch(path,{method:'PUT',headers,body:'updated'});const next=(await update.json()).version;
    const stale=await fetch(path,{method:'PUT',headers,body:'stale'});
    const staleDelete=await fetch(path,{method:'DELETE',headers});
    const remove=await fetch(path,{method:'DELETE',headers:{'If-Match':next}});
    const missing=await fetch(path);
    const escape=await fetch('./__quickapp/files?path=../outside.txt');
    return [create.status,update.status,stale.status,staleDelete.status,remove.status,missing.status,escape.status];
  })()`, context)
  assert.deepEqual(result, [200, 200, 412, 412, 200, 404, 403])
  assert.equal(await evaluate('fetch("/api/workspaces").then(()=>"readable",()=>"blocked")', context), 'blocked')
  assert.equal(await evaluate('fetch("/data.json").then(r=>r.ok,()=>false)', context), false, 'Root-relative requests do not map to a workspace under a path proxy')
  assert.equal(f.seen.filter(item => item.path.includes('/__codingns/quick-apps/')).some(item => item.cookie || item.authorization), false)
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth', context), true)
  await f.service.invalidate(f.app.id)
  assert.equal(await evaluate('fetch("./data.json").then(r=>r.ok,()=>false)', context), false)
  assert.equal(await evaluate('fetch("/").then(r=>r.status)'), 200)
  t.diagnostic('Actual Chromium through the existing Host/LAN route; no app certificates/listeners, synthetic conversation or injected SDK. HTTPS fixture uses only its existing ingress certificate. Phone width is emulation only.')
})
