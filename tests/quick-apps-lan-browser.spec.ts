import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:https'
import { request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { quickAppLanFixture, closeFixtureServer } from './quick-apps-lan-fixture.js'
import { quickAppBrowser } from './quick-apps-browser-driver.js'

test('same-host LAN HTTPS app ports in a real browser: unchanged resources, ambient cookies, CSRF and scoped writes', { timeout: 60_000 }, async t => {
  const f = await quickAppLanFixture(); t.after(f.dispose)
  const first = await f.launch(); const second = await f.launch()
  f.setUiBody(`<meta name="viewport" content="width=device-width,initial-scale=1"><p id="privileged">DSH fixture</p><iframe id="app" style="width:95%;height:600px" sandbox="allow-scripts allow-same-origin allow-forms" src="${first.url}"></iframe><iframe id="other" sandbox="allow-scripts allow-same-origin" src="${second.url}"></iframe>`)
  // Reproduce a common ingress: TLS terminates here and Host becomes the internal
  // proxy address, while Origin/Referer/Fetch Metadata retain the browser values.
  const ingress = createServer({ cert: f.cert, key: f.key }, (req, res) => {
    const upstream = request({ hostname: '127.0.0.1', port: f.proxyPort, path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${f.proxyPort}` }, agent: false }, reply => {
      res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res)
    })
    upstream.on('error', () => { res.writeHead(502); res.end() }); req.pipe(upstream)
  })
  const sockets = new Set<import('node:net').Socket>()
  ingress.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  ingress.on('upgrade', (req, socket, head) => {
    const upstream = request({ hostname: '127.0.0.1', port: f.proxyPort, path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${f.proxyPort}` }, agent: false })
    upstream.on('upgrade', (reply, target, upstreamHead) => {
      sockets.add(target); target.on('close', () => sockets.delete(target))
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(reply.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length) socket.write(upstreamHead)
      if (head.length) target.write(head)
      socket.pipe(target); target.pipe(socket)
      socket.on('close', () => target.destroy()); target.on('close', () => socket.destroy())
      target.on('error', () => socket.destroy())
    })
    upstream.on('response', reply => { reply.resume(); socket.end(`HTTP/1.1 ${reply.statusCode} Denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`) })
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); upstream.end()
  })
  t.after(async () => { for (const socket of sockets) socket.destroy(); await closeFixtureServer(ingress) })
  await new Promise<void>(resolve => ingress.listen(f.uiPort, '127.0.0.1', resolve))
  const browser = await quickAppBrowser(t, [`--host-resolver-rules=MAP lan.dsh.test 127.0.0.1`, `--ignore-certificate-errors-spki-list=${f.spki}`])
  if (!browser) return
  const { command, evaluate, contexts } = browser
  await command('Page.enable'); await command('Network.enable')
  await command('Page.navigate', { url: f.uiOrigin, referrer: 'https://portal.example/' })
  let context: number | undefined
  for (let attempt = 0; attempt < 80; attempt++) {
    const tree = await command('Page.getFrameTree')
    const frame = tree.frameTree.childFrames?.find((child: any) => child.frame.url === `${first.origin}/index.html`)
    context = frame && contexts.get(frame.frame.id)
    if (context && await evaluate('!!window.fixtureReady', context)) break
    context = undefined
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(context, 'Real embedded bootstrap and unchanged app reached fixtureReady')
  assert.deepEqual(await evaluate('({result:document.querySelector("#result").textContent,color:getComputedStyle(document.body).color,image:document.querySelector("img").naturalWidth,font:document.fonts.check("16px FixtureFont"),cookie:document.cookie})', context),
    { result: 'module|dynamic|fetch|unicode|classic', color: 'rgb(20, 40, 60)', image: 1, font: true, cookie: '' })
  assert.equal(await evaluate('fetch("/api/workspaces").then(r=>r.status)'), 200)
  assert.equal(await evaluate(`new Promise(resolve=>{const ws=new WebSocket(location.origin.replace('https:','wss:')+'/ws');ws.onopen=()=>ws.send('native-connection');ws.onmessage=e=>{resolve(e.data);ws.close()};ws.onerror=()=>resolve('failed')})`), 'native-connection')
  const upgradeCount = f.requests.filter(request => request.url === '/ws').length
  assert.equal(await evaluate(`new Promise(resolve=>{const ws=new WebSocket(${JSON.stringify(f.uiOrigin.replace('https:', 'wss:') + '/ws')});ws.onopen=()=>{resolve('leaked');ws.close()};ws.onerror=()=>resolve('blocked')})`, context), 'blocked')
  assert.equal(f.requests.filter(request => request.url === '/ws').length, upgradeCount)
  assert.equal(await evaluate('(()=>{try{return parent.document.querySelector("#privileged").textContent}catch{return "blocked"}})()', context), 'blocked')
  assert.equal(await evaluate('(()=>{try{return document.querySelector("#app").contentWindow.document.body.innerText}catch{return "blocked"}})()'), 'blocked')
  const privilegedCount = f.requests.filter(request => request.url.startsWith('/api/')).length
  for (const expression of [
    `fetch(${JSON.stringify(`${f.uiOrigin}/api/workspaces`)},{credentials:'include'}).then(()=>'leaked',()=>'blocked')`,
    `fetch(${JSON.stringify(`${second.origin}/data.json`)},{credentials:'include'}).then(()=>'leaked',()=>'blocked')`,
  ]) assert.equal(await evaluate(expression, context), 'blocked')
  await evaluate(`fetch(${JSON.stringify(`${f.uiOrigin}/api/codingns/quickApps/launch`)},{method:'POST',mode:'no-cors',credentials:'include',body:'attack'}).then(()=>true,()=>true)`, context)
  await evaluate(`new Promise(resolve=>{const frame=document.createElement('iframe');frame.referrerPolicy='no-referrer';frame.src=${JSON.stringify(`${f.uiOrigin}/api/workspaces`)};frame.onload=()=>resolve(true);document.body.append(frame)})`, context)
  assert.equal(f.requests.filter(request => request.url.startsWith('/api/')).length, privilegedCount, 'No cross-port request reaches privileged DSH')
  const result = await evaluate(`(async()=>{
    const path='/__quickapp/files?path=data/browser.txt';
    const create=await fetch(path,{method:'PUT',headers:{'Content-Type':'text/plain','If-None-Match':'*'},body:'created'});
    const version=(await create.json()).version;
    const headers={'Content-Type':'text/plain','If-Match':version};
    const update=await fetch(path,{method:'PUT',headers,body:'updated'});const next=(await update.json()).version;
    const stale=await fetch(path,{method:'PUT',headers,body:'stale'});
    const staleDelete=await fetch(path,{method:'DELETE',headers});
    const remove=await fetch(path,{method:'DELETE',headers:{'If-Match':next}});
    const missing=await fetch(path);const noReferrer=await fetch('/data.json',{referrerPolicy:'no-referrer'});
    const escape=await fetch('/__quickapp/files?path=../outside.txt');
    const secret=await fetch('/__quickapp/files?path=.env');
    return [create.status,update.status,stale.status,staleDelete.status,remove.status,missing.status,noReferrer.status,escape.status,secret.status];
  })()`, context)
  assert.deepEqual(result, [200, 200, 412, 412, 200, 404, 200, 403, 403])
  assert.equal(await readFile(join(f.root, 'data/member.json'), 'utf8'), '{"value":1}')
  const cookies = await command('Network.getCookies', { urls: [f.uiOrigin, first.origin, second.origin] })
  assert.ok(cookies.cookies.some((cookie: any) => cookie.name === 'dsh_browser' && cookie.httpOnly))
  assert.ok(cookies.cookies.filter((cookie: any) => cookie.name.startsWith('__Host-quickapp-')).length >= 2)
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth', context), true)
  await f.service.invalidate(f.app.id)
  assert.equal(await evaluate('fetch("/data.json").then(r=>r.ok?"leaked":"denied",()=>"denied")', context), 'denied')
  assert.equal(await evaluate('fetch("/api/workspaces").then(r=>r.status)'), 200)
  t.diagnostic('Actual Chromium, Host-rewriting TLS ingress + LAN proxy + two app ports. 390px emulation is not physical-phone validation. No installed profile or system trust changes.')
})
