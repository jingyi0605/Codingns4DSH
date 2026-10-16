import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:https'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { build } from 'tsdown'
import { quickAppHttpsFixture } from './quick-apps-https-fixture.js'
import { quickAppBrowser } from './quick-apps-browser-driver.js'
import { createQuickAppsFeature } from '../src/host/features/quick-apps.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { registerCodingNsRpc } from '../src/host/rpc.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { fixtureWorkspaceDirectoryBrowser } from './fixtures/quick-app-directory.js'

test('inline sidebar grid stays above Settings at desktop, mobile and rail widths, and opens unchanged HTTPS apps', { timeout: 90_000 }, async t => {
  const f = await quickAppHttpsFixture(); t.after(f.dispose)
  const markdown = '# Workspace guide\n\n> A native Markdown document\n\n| Feature | Status |\n| --- | --- |\n| Viewing | **Ready** |\n\n```js\nconst value = 42\n```\n\n![Pixel](assets/pixel.png)\n\n[Next document](next.md)\n\n[Outside folder](../data/member.json)\n\n<script>window.markdownExecuted=true</script>\n'
  await writeFile(join(f.root, 'site/notes.md'), markdown)
  await writeFile(join(f.root, 'site/next.md'), '# Linked document\n')
  const browser = await quickAppBrowser(t, [`--host-resolver-rules=MAP *.test 127.0.0.1`, `--ignore-certificate-errors-spki-list=${f.spki}`, '--test-third-party-cookie-phaseout'])
  if (!browser) return
  const outDir = join(f.root, 'ui-build')
  // The native renderer's typography and palette live in the theme plugin, not its component CSS.
  const themeBundle = await readFile(new URL('../node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js', import.meta.url), 'utf8')
  const themeCss = [...themeBundle.matchAll(/var \w+_css_default = ("(?:\\.|[^"\\])*");/gu)].map(match => JSON.parse(match[1]!)).join('\n')
  assert.ok(themeCss.includes('--dsw-font-markdown-h1'))
  await build({ config: false, entry: ['tests/fixtures/quick-app-launcher.ts'], outDir, platform: 'browser', format: 'iife', dts: false, sourcemap: false, clean: true,
    define: { 'process.env.NODE_ENV': '"production"' }, deps: { alwaysBundle: () => true, onlyBundle: false }, css: { inject: false }, loader: { '.woff2': 'dataurl', '.ttf': 'dataurl' } })
  let settings = { ...DEFAULT_CODINGNS_SETTINGS, quickApps: [f.app, { ...f.app, id: 'markdown-guide', title: 'Markdown Guide', kind: 'text' as const, entryPath: 'site/notes.md', order: 4 }, ...['Project Notes', 'Roadmap', '工作日志'].map((title, index) => ({ ...f.app, id: `document-${index}`, title, kind: 'text' as const, entryPath: 'site/空 格.txt', order: index + 1 }))] }
  const rpc = new CodingNsRpcTable()
  const modules = new FeatureRegistry({ rpc, quickAppOrigins: f.provider, workspaceDirectoryBrowser: fixtureWorkspaceDirectoryBrowser(), resolveManagedWorkspaceRoot: f.registry.workspaceRoot,
    settings: { get: () => settings, update: async patch => { settings = { ...settings, ...patch }; await writeFile(join(f.root, 'settings.json'), JSON.stringify(settings)) } } })
  modules.register(createQuickAppsFeature()); await modules.start('quickApps'); t.after(() => modules.disable('quickApps'))
  const calls: string[] = []
  let channel!: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  let disposeRpc!: () => Promise<void>
  const peer = { id: 'fixture-owner', principal: { kind: 'owner' } }
  registerCodingNsRpc({
    effect(factory: () => () => Promise<void>) { disposeRpc = factory() },
    webServer: { register(route: { handler: typeof channel }) { channel = route.handler; return () => {} } },
    connection: { browserPeer: peer, admit: ({ headers }: { headers: IncomingMessage['headers'] }) =>
      headers.origin === f.uiOrigin && headers.cookie?.includes('__Host-fixture-owner=fixture') ? { peer } : { rejection: 403 },
    fetch: { register: () => () => {} } },
  } as never, rpc)
  t.after(() => disposeRpc())
  const ui = createServer({ cert: f.cert, key: f.key }, async (request, response) => {
    if (request.url?.startsWith('/codingns/')) {
      calls.push(request.url.slice('/codingns/'.length))
      await channel(request, response); return
    }
    if (request.url === '/theme.css') { response.setHeader('Content-Type', 'text/css; charset=utf-8'); response.end(themeCss); return }
    if (request.url === '/quick-app-launcher.iife.js' || request.url === '/style.css') { response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'); response.end(await readFile(join(outDir, basename(request.url)))); return }
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.setHeader('Set-Cookie', '__Host-fixture-owner=fixture; Secure; HttpOnly; Path=/; SameSite=Strict')
    response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/style.css"><style>body{margin:0;font:14px system-ui;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#17191c);--dsw-alias-bg-mask-1:#0005;--dsw-radius-panel:12px}</style><div id="root"></div><script src="/quick-app-launcher.iife.js"></script>')
  })
  await new Promise<void>(resolve => ui.listen(f.uiPort, '127.0.0.1', resolve))
  const transportEvents: string[] = []
  ui.on('connection', () => transportEvents.push('tcp'))
  ui.on('secureConnection', () => transportEvents.push('tls'))
  ui.on('tlsClientError', error => transportEvents.push(`tls-error:${error.message}`))
  t.after(async () => { ui.closeAllConnections(); await new Promise<void>(resolve => ui.close(() => resolve())) })
  const { evaluate, command } = browser
  await command('Page.enable')
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await command('Page.addScriptToEvaluateOnNewDocument', { source: 'window.fixtureErrors=[];window.addEventListener("error",event=>window.fixtureErrors.push(event.message));window.addEventListener("unhandledrejection",event=>window.fixtureErrors.push(String(event.reason)))' })
  const waitFor = async (expression: string) => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>(document.body&&(${expression}))?resolve(true):Date.now()>end?reject(new Error('UI condition failed: '+document.body?.innerText+' '+JSON.stringify(window.fixtureErrors))):setTimeout(check,25);check()})`)
  const click = (text: string) => evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}||b.getAttribute('aria-label')===${JSON.stringify(text)});if(!b)throw new Error('Button missing: '+${JSON.stringify(text)});b.focus();b.click()})()`)
  const shortcut = (title: string) => evaluate(`(()=>{const b=[...document.querySelectorAll('.qa-tile')].find(b=>b.querySelector('strong').textContent===${JSON.stringify(title)});if(!b)throw new Error('Shortcut missing');b.focus();b.click()})()`)
  const set = (label: string, value: string) => evaluate(`(()=>{const label=[...document.querySelectorAll('label')].find(e=>e.firstChild?.textContent===${JSON.stringify(label)});const e=label.querySelector('input,select');Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}))})()`)
  const navigation = await command('Page.navigate', { url: f.uiOrigin })
  assert.equal(navigation.errorText, undefined, JSON.stringify({ navigation, transportEvents }))
  await waitFor('document.querySelector(".qa-tile")')
  const assertInlineGrid = async (columns: number) => {
    const layout = await evaluate(`(()=>{const rail=document.querySelector('.codingns-quick-app-rail').getBoundingClientRect();const settings=document.querySelector('.fixture-settings').getBoundingClientRect();return {dialog:!!document.querySelector('[role=dialog]'),above:rail.bottom<=settings.top,settingsVisible:settings.bottom<=innerHeight,inside:rail.left>=0&&rail.right<=innerWidth,columns:getComputedStyle(document.querySelector('.qa-grid')).gridTemplateColumns.split(' ').length,overflow:document.documentElement.scrollWidth>innerWidth}})()`)
    assert.deepEqual(layout, { dialog: false, above: true, settingsVisible: true, inside: true, columns, overflow: false })
  }
  await assertInlineGrid(4)
  await click('Add shortcut')
  assert.equal(await evaluate('Math.abs(document.querySelector("[role=dialog]").getBoundingClientRect().width-innerWidth*.6)<2'), true)
  await click('Workspace'); await waitFor('document.querySelector(".codingns-quick-app-workspaces [role=menuitem]")')
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  assert.equal(await evaluate('!!document.querySelector("form")&&!document.querySelector(".codingns-quick-app-workspaces")'), true)
  await click('Workspace'); await evaluate('document.querySelector(".codingns-quick-app-workspaces [role=menuitem]").click()')
  await click('Browse…'); await waitFor('document.querySelector(".qa-file-row")'); await click('site')
  await waitFor('document.querySelector(".qa-file-picker").textContent.includes("空 格.txt")'); await click('空 格.txt'); await click('Use this file')
  await waitFor('!document.querySelector(".qa-file-picker")')
  assert.equal(await evaluate('document.querySelector("form input").value'), 'site/空 格.txt')
  await set('Title', 'Literal document'); await click('Save')
  await waitFor('document.body.innerText.includes("Literal document")&&!document.querySelector("form")')
  await evaluate('window.fixtureBeforeReload=true')
  await command('Page.reload'); await waitFor('!window.fixtureBeforeReload&&document.body.innerText.includes("Literal document")')
  await assertInlineGrid(4)
  const artifactDir = new URL('../data/build/review/', import.meta.url)
  await mkdir(artifactDir, { recursive: true })
  const capture = async (name: string) => {
    await evaluate('Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))')
    const shot = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(new URL(name, artifactDir), Buffer.from(shot.data, 'base64'))
  }
  await capture('spec016-sidebar-desktop.png')
  await click('Collapse sidebar'); await assertInlineGrid(1)
  await capture('spec016-sidebar-collapsed.png')
  await click('Expand sidebar'); await assertInlineGrid(4)
  await shortcut('Literal document')
  await waitFor('document.querySelector("pre")'); assert.equal(await evaluate('document.querySelector("pre").textContent'), 'unicode\n')
  assert.equal(await evaluate('document.querySelector(".qa-view-toolbar").getBoundingClientRect().height'), 38)
  assert.equal(await evaluate('document.querySelector(".qa-view-path").textContent'), 'site/空 格.txt')
  await capture('spec016-viewer-text-desktop.png')
  const updatedText = '<script>window.viewerExecuted=true</script>\n' + 'workspace document '.repeat(70)
  await writeFile(join(f.root, 'site/空 格.txt'), updatedText)
  await click('Reload'); await waitFor('document.querySelector("pre").textContent.includes("viewerExecuted")')
  assert.equal(await evaluate('document.querySelector("pre").textContent'), updatedText)
  assert.equal(await evaluate('window.viewerExecuted'), undefined)
  await click('Wrap text')
  assert.equal(await evaluate('getComputedStyle(document.querySelector("pre")).whiteSpace'), 'pre')
  assert.equal(await evaluate('document.querySelector(".qa-view-text-body").scrollWidth>document.querySelector(".qa-view-text-body").clientWidth&&document.documentElement.scrollWidth<=innerWidth'), true)
  await click('Wrap text')
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  assert.equal(await evaluate('document.querySelector(".qa-view-tool").getBoundingClientRect().width'), 40)
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth&&document.querySelector(".qa-view-text-body").scrollWidth<=document.querySelector(".qa-view-text-body").clientWidth'), true)
  await capture('spec016-viewer-text-mobile.png')
  await click('Back to shortcuts'); await writeFile(join(f.root, 'site/空 格.txt'), 'unicode\n')
  await command('Emulation.setTouchEmulationEnabled', { enabled: false })
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await shortcut('Markdown Guide'); await waitFor('document.querySelector(".qa-document-markdown h1")')
  assert.equal(await evaluate('document.querySelector(".qa-document-markdown h1").textContent'), 'Workspace guide')
  await waitFor('document.querySelector(".qa-document-markdown img")?.naturalWidth===1')
  assert.equal(await evaluate('!!document.querySelector(".qa-document-markdown blockquote")&&!!document.querySelector(".qa-document-markdown table")'), true)
  assert.equal(await evaluate('window.markdownExecuted'), undefined)
  await capture('spec016-native-markdown-desktop.png')
  await click('Maximize viewer')
  assert.equal(await evaluate('document.querySelector(".qa-viewer").getBoundingClientRect().width===innerWidth'), true)
  await click('Restore viewer')
  assert.ok(await evaluate('document.querySelector(".qa-viewer").getBoundingClientRect().width<innerWidth'))
  await click('Next document')
  await waitFor('document.querySelector(".qa-document-markdown h1")?.textContent==="Linked document"')
  await click('Back to entry document'); await waitFor('document.querySelector(".qa-document-markdown h1")?.textContent==="Workspace guide"')
  await click('Edit'); await waitFor('document.querySelector(".qa-view-confirm")')
  await click('Cancel'); assert.equal(calls.filter(call => call === 'quickApps/document').length > 0, true)
  await click('Edit'); await click('Allow editing'); await waitFor('document.querySelector(".cm-content")')
  const typeDocument = async (content: string) => {
    await evaluate('document.querySelector(".cm-content").focus()')
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2 })
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2 })
    await command('Input.insertText', { text: content })
  }
  await typeDocument('# Edited document\n\nSaved from the native editor.\n')
  await waitFor('document.querySelector(".qa-document-dirty")')
  await capture('spec016-native-editor-desktop.png')
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: process.platform === 'darwin' ? 4 : 2 })
  await waitFor('document.querySelector(".qa-view-status")?.textContent==="Saved to the workspace."')
  assert.equal(await readFile(join(f.root, 'site/notes.md'), 'utf8'), '# Edited document\n\nSaved from the native editor.\n')
  await typeDocument('# Preserved draft\n')
  await writeFile(join(f.root, 'site/notes.md'), '# External update\n')
  await click('Save'); await waitFor('document.querySelector(".qa-view-error")?.textContent.includes("file changed")')
  assert.equal(await evaluate('document.querySelector(".cm-content").textContent'), '# Preserved draft')
  assert.equal(await readFile(join(f.root, 'site/notes.md'), 'utf8'), '# External update\n')
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await waitFor('document.querySelector(".qa-view-confirm")'); await click('Cancel')
  assert.ok(await evaluate('!!document.querySelector(".cm-content")'))
  await click('View as'); await waitFor('document.querySelector("[role=menuitem]")'); await click('Markdown')
  assert.equal(await evaluate('document.querySelector(".qa-document-markdown h1").textContent'), 'Preserved draft')
  await click('Reload'); await click('Discard changes'); await waitFor('document.querySelector(".qa-document-markdown h1")?.textContent==="External update"')
  await click('Back to shortcuts')
  await click('Edit shortcuts'); await shortcut('Fixture')
  assert.equal(await evaluate('document.body.innerText.includes("read, create, update and delete files")'), true)
  assert.equal(await evaluate('document.body.innerText.includes("File permissions")'), false)
  await click('Save and allow workspace access')
  await waitFor('!document.querySelector("form")')
  assert.equal(settings.quickApps.find(app => app.id === f.app.id)?.fileAccess, 'workspace')
  assert.equal(calls.includes('quickApps/grant'), false)
  await click('Done'); await shortcut('Fixture'); await waitFor('document.querySelector("iframe")')
  const previousAppUrl = await evaluate('document.querySelector("iframe").src')
  await click('Reload')
  await waitFor(`document.querySelector("iframe").src!==${JSON.stringify(previousAppUrl)}&&!document.querySelector('.qa-view-surface').getAttribute('aria-busy').includes('true')`)
  assert.equal((await f.http(new URL(previousAppUrl).origin, '/index.html')).status, 421, 'the shared listener must reject the retired app Host')
  const appUrl = await evaluate('document.querySelector("iframe").src')
  const origin = new URL(appUrl).origin
  assert.deepEqual(await evaluate('(()=>{const address=document.querySelector(".qa-view-address");return {value:address.value,readOnly:address.readOnly}})()'), { value: `${origin}/index.html`, readOnly: true })
  let appTarget: any; let appFrame: any
  for (let attempt = 0; attempt < 100; attempt++) {
    appTarget = (await browser.call('Target.getTargets')).targetInfos.find((target: any) => target.type === 'iframe' && target.url.startsWith(origin))
    appFrame = (await command('Page.getFrameTree')).frameTree.childFrames?.[0]?.frame
    if (appTarget?.url.endsWith('/index.html') || appFrame?.url.endsWith('/index.html')) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.ok(appTarget?.url.endsWith('/index.html') || appFrame?.url.endsWith('/index.html'), JSON.stringify({ appTarget, appFrame }))
  const context = browser.contexts.get(appFrame?.id)
  const app = appTarget ? await browser.attach(appTarget.targetId) : { evaluate: (expression: string) => browser.evaluate(expression, context) }
  assert.ok(appTarget || context)
  await app.evaluate('new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>window.fixtureReady?resolve(true):Date.now()>end?reject(new Error(document.body.innerText)):setTimeout(check,20);check()})')
  assert.deepEqual(await app.evaluate('({result:document.querySelector("#result").textContent,cookie:document.cookie,referrer:document.referrer,hash:location.hash})'), { result: 'module|dynamic|fetch|unicode|classic', cookie: '', referrer: '', hash: '' })
  assert.equal(await evaluate('(()=>{try{document.querySelector("iframe").contentWindow.document.body;return false}catch{return true}})()'), true)
  await capture('spec016-viewer-html-desktop.png')
  await click('Maximize viewer'); assert.equal(await evaluate('document.querySelector(".qa-viewer").getBoundingClientRect().width===innerWidth'), true)
  assert.equal(await app.evaluate('document.querySelector("#result").textContent'), 'module|dynamic|fetch|unicode|classic')
  await click('Restore viewer')
  const saves = await app.evaluate(`(async()=>{const path='/__quickapp/files?path=data/member.json';const before=await fetch(path).then(r=>r.json());const headers={'Content-Type':'text/plain','If-Match':before.version};const save=()=>fetch(path,{method:'PUT',headers,body:'saved via launcher'});return [(await save()).status,(await save()).status,(await fetch(path,{method:'DELETE',headers})).status]})()`)
  assert.deepEqual(saves, [200, 412, 412]); assert.equal(await readFile(join(f.root, 'data/member.json'), 'utf8'), 'saved via launcher')
  const createdAndDeleted = await app.evaluate(`(async()=>{const path='/__quickapp/files?path=quick-app-created.txt';const created=await fetch(path,{method:'PUT',headers:{'Content-Type':'text/plain','If-None-Match':'*'},body:'new file'});const saved=await created.json();return [created.status,(await fetch(path,{method:'DELETE',headers:{'If-Match':saved.version}})).status]})()`)
  assert.deepEqual(createdAndDeleted, [200, 200])
  const cookies = (await browser.call('Storage.getCookies', { browserContextId: browser.browserContextId })).cookies
  const appCookie = cookies.find((cookie: any) => cookie.name === '__Host-quickapp' && cookie.domain === new URL(origin).hostname)
  assert.equal(appCookie.httpOnly, true); assert.equal(appCookie.secure, true); assert.ok(appCookie.partitionKey)
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth&&document.querySelector("[role=dialog]").getBoundingClientRect().right<=innerWidth'), true)
  assert.ok(await evaluate('document.querySelector("iframe").getBoundingClientRect().height>600'))
  const shot = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(new URL('spec016-launcher-mobile.png', artifactDir), Buffer.from(shot.data, 'base64'))
  await capture('spec016-viewer-html-mobile.png')
  await click('Back to shortcuts'); await waitFor('!document.querySelector("iframe")'); await click('Edit shortcuts'); await shortcut('Fixture'); await click('Revoke access')
  await waitFor('document.body.innerText.includes("File access revoked")'); await click('Cancel')
  assert.equal(settings.quickApps.find(app => app.id === f.app.id)?.fileAccess, undefined)
  await assert.rejects(f.http(origin, '/index.html', { headers: { cookie: `__Host-quickapp=${appCookie.value}` } }), /ECONNREFUSED/u)
  assert.ok(calls.every(endpoint => endpoint.startsWith('quickApps/')))
  await assertInlineGrid(4)
  await capture('spec016-sidebar-mobile.png')
  await shortcut('Literal document'); await click('Remove shortcut'); await click('Cancel')
  assert.ok(await evaluate('document.querySelector("form")!==null'))
  await click('Remove shortcut'); await click('Remove shortcut')
  await waitFor('!document.body.innerText.includes("Literal document")')
  assert.equal(await readFile(join(f.root, 'site/空 格.txt'), 'utf8'), 'unicode\n')
  await shortcut('Fixture'); await set('Title', 'Edited fixture')
  await click('Workspace'); await waitFor('document.querySelector(".codingns-quick-app-workspaces")')
  await capture('spec016-picker-workspaces-mobile.png')
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await click('Browse…'); await waitFor('document.querySelector(".qa-file-row")')
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll("[role=dialog]")].every(e=>e.getBoundingClientRect().right<=innerWidth)'), true)
  await capture('spec016-picker-files-mobile.png')
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await waitFor('!document.querySelector(".qa-file-picker")')
  assert.equal(await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="Browse…")===document.activeElement'), true)
  await evaluate('document.querySelector("details>summary").click()')
  await set('List order', '5'); await click('Add resource folder')
  await set('App URL path', '/extra'); await set('Workspace folder', 'data')
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
  await capture('spec016-sidebar-form-mobile.png')
  await click('Save and allow workspace access'); await waitFor('document.body.innerText.includes("Edited fixture")&&!document.querySelector("form")')
  const edited = settings.quickApps.find(app => app.id === f.app.id)!
  assert.equal(edited.order, 5); assert.deepEqual(edited.mounts, [{ urlPrefix: '/extra', workspacePath: 'data', read: true }])
  await assertInlineGrid(4)
  await evaluate('document.documentElement.style.cssText="color-scheme:dark;--dsw-alias-bg-layer-1:#181a20;--dsw-alias-bg-layer-2:#20232a;--dsw-alias-label-primary:#f1f3f5;--dsw-alias-label-secondary:#b5bbc5;--dsw-alias-border-l2:#424957;--dsw-alias-border-l4:#424957;--dsw-specific-input-major:#252932";document.body.style.setProperty("--dsw-alias-bg-layer-2","#20232a");document.body.style.setProperty("--dsw-alias-label-primary","#f1f3f5")')
  await capture('spec016-sidebar-dark-mobile.png')
  await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
  await assertInlineGrid(4)
  await shortcut('Edited fixture')
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await waitFor('!document.querySelector("[role=dialog]")')
  assert.equal(await evaluate('document.activeElement.classList.contains("qa-tile")'), true)
  await assertInlineGrid(4)
  await click('Done'); await shortcut('Project Notes'); await waitFor('document.querySelector("pre")')
  await evaluate('document.body.setAttribute("data-ds-dark-theme", "");document.body.style.setProperty("--dsh-content-font-size-secondary","18px")')
  assert.equal(await evaluate('getComputedStyle(document.querySelector("pre")).fontSize'), '18px')
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth&&document.querySelector(".qa-view-text-body").getBoundingClientRect().height>500'), true)
  await capture('spec016-viewer-text-dark-mobile.png')
  await click('Back to shortcuts')
  await writeFile(join(f.root, 'site/notes.md'), markdown)
  await shortcut('Markdown Guide'); await waitFor('document.querySelector(".qa-document-markdown h1")')
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
  await capture('spec016-native-markdown-dark-mobile.png')
  await click('Edit'); await click('Allow editing'); await waitFor('document.querySelector(".cm-content")')
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
  await capture('spec016-native-editor-dark-mobile.png')
  await click('Back to shortcuts')
  await shortcut('Edited fixture'); await waitFor('document.querySelector("iframe")')
  assert.equal(await evaluate('document.querySelector(".qa-view-address").getBoundingClientRect().right<=innerWidth'), true)
  await capture('spec016-viewer-html-dark-mobile.png')
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' })
  await waitFor('!document.querySelector("[role=dialog]")')
  assert.equal(await evaluate('window.fixtureErrors.length'), 0)
  t.diagnostic('Actual React/DSH primitives and Host feature over disposable HTTPS in a fixture reproducing the pinned native sidebar seats; native cookie bootstrap with third-party cookie phaseout. No installed DSH or physical phone was used.')
})
