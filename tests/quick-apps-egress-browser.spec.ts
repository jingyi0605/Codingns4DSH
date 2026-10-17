import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { quickAppProxyFixture } from './quick-apps-proxy-fixture.js'
import { quickAppBrowser } from './quick-apps-browser-driver.js'

test('sandboxed quick app reads cross-host responses through host egress after document hydration', { timeout: 60_000 }, async t => {
  const seen: { url?: string; authorization?: string; origin?: string; host?: string }[] = []
  const upstream = createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization, origin: req.headers.origin, host: req.headers.host })
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end('{"models":["proxied"]}')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  t.after(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const port = (upstream.address() as { port: number }).port
  const f = await quickAppProxyFixture(); t.after(() => f.dispose())
  const page = `<!doctype html><script>
    window.bootErrors = [];
    addEventListener('error', event => bootErrors.push(String(event.message)));
    window.boot = {};
    try { boot.storage = localStorage.getItem('probe'); } catch (error) { boot.storageError = error instanceof Error ? error.message : String(error); }
    boot.fetchNative = String(fetch).includes('[native code]');
    boot.origin = location.origin;
    window.fixtureReady = false;
    void (async () => {
      try {
        const local = await fetch(${JSON.stringify(`http://127.0.0.1:${port}/v1/models`)}, { headers: { Authorization: 'Bearer secret' } });
        boot.localStatus = local.status;
        boot.localType = local.headers.get('content-type');
        boot.localBody = await local.text();
      } catch (error) { boot.localError = error instanceof Error ? error.name + ': ' + error.message : String(error); }
      try {
        const remote = await fetch('https://api.glor-ai.top:1443/v1/models');
        boot.remoteStatus = remote.status;
        boot.remoteBody = (await remote.text()).slice(0, 180);
      } catch (error) { boot.remoteError = error instanceof Error ? error.name + ': ' + error.message : String(error); }
      window.fixtureReady = true;
    })();
  </script>`
  await writeFile(join(f.root, 'site/egress.html'), page)
  const current = f.registry.get(f.app.id)
  await f.registry.upsert({ ...current, entryPath: 'site/egress.html', networkAllow: ['127.0.0.1'] }, current.revision)
  const app = await f.launch(f.origin, true)
  f.setUi(`<meta name="viewport" content="width=device-width,initial-scale=1"><iframe id="app" sandbox="allow-scripts allow-forms allow-downloads" src="${app.url}"></iframe><script>
    const token = ${JSON.stringify(app.storageToken)};
    const protocol = 'codingns.quick-app-storage.v1';
    addEventListener('message', event => {
      const frame = document.getElementById('app');
      const data = event.data;
      if (!frame || event.source !== frame.contentWindow || event.origin !== 'null' || !data || data.type !== protocol || data.token !== token || typeof data.documentId !== 'string') return;
      const channel = new MessageChannel();
      channel.port1.onmessage = message => {
        const request = message.data || {};
        channel.port1.postMessage({ id: request.id, value: request.operation === 'keys' ? [] : null, entries: [] });
      };
      frame.contentWindow.postMessage({ type: protocol, token, documentId: data.documentId, snapshot: { local: [], session: [] }, errors: {} }, '*', [channel.port2]);
    });
  </script>`)
  const browser = await quickAppBrowser(t); if (!browser) return
  const { command, evaluate, contexts } = browser
  await command('Page.enable'); await command('Runtime.enable')
  await command('Page.navigate', { url: f.origin })
  let context: number | undefined
  let frameUrl = ''
  for (let attempt = 0; attempt < 80; attempt++) {
    const tree = await command('Page.getFrameTree')
    const frame = tree.frameTree.childFrames?.find((child: { frame: { url: string; id: string } }) => child.frame.url.includes('egress.html'))
    frameUrl = frame?.frame.url ?? ''
    context = frame && contexts.get(frame.frame.id)
    if (context && await evaluate('!!window.fixtureReady', context).catch(() => false)) break
    context = undefined
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(context, `Egress page did not hydrate. Frame URL: ${frameUrl}`)
  const boot = await evaluate('boot', context)
  const errors = await evaluate('bootErrors', context)
  assert.equal(boot.fetchNative, false, `fetch stayed native after hydration: ${JSON.stringify(boot)} errors=${JSON.stringify(errors)}`)
  assert.equal(boot.storageError, undefined, `localStorage threw after the storage facade: ${boot.storageError}`)
  assert.equal(boot.localError, undefined, boot.localError)
  assert.equal(boot.localStatus, 200)
  assert.equal(boot.localType, 'application/json; charset=utf-8')
  assert.equal(boot.localBody, '{"models":["proxied"]}')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.authorization, 'Bearer secret')
  assert.equal(seen[0]?.origin, undefined)
  assert.equal(seen[0]?.host, `127.0.0.1:${port}`)
  assert.equal(boot.remoteError, undefined, boot.remoteError)
  assert.equal(boot.remoteStatus, 401)
  assert.match(boot.remoteBody, /API_KEY/u)
  assert.deepEqual(errors, [])
})
