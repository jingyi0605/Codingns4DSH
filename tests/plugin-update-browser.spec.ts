import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'tsdown'
import { quickAppBrowser } from './quick-apps-browser-driver.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { registerCodingNsRpc } from '../src/host/rpc.js'
import { createPluginUpdateFeature } from '../src/host/features/plugin-update.js'
import { CODINGNS_PACKAGE_NAME } from '../src/shared/contracts/plugin-update.js'
import { CODINGNS_VERSION } from '../src/shared/contracts/version.js'

test('isolated settings browser exercises real HTTP authorization, confirmation, recovery, cancellation and truthful activation', { timeout: 90_000 }, async t => {
  const browser = await quickAppBrowser(t)
  if (!browser) return
  const root = await mkdtemp(join(tmpdir(), 'plugin-update-ui-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outDir = join(root, 'build')
  await build({ config: false, entry: ['tests/fixtures/plugin-update-panel.ts'], outDir, platform: 'browser', format: 'iife',
    dts: false, sourcemap: false, clean: true, define: { 'process.env.NODE_ENV': '"production"' },
    deps: { alwaysBundle: () => true, onlyBundle: false }, css: { inject: false } })
  const version = '0.2.2-rc.10'
  const longVersion = `0.2.4-rc.${'a'.repeat(80)}`
  const incompatible = '0.2.3-rc.1'
  const commit = 'a'.repeat(40)
  const body = '<script>window.releaseExecuted=true</script>\nFixture release notes\n' + 'long-line-'.repeat(80)
  const metadataPaths: string[] = []
  let offline = false
  const request: typeof fetch = async url => {
    if (offline) throw new Error('Fixture metadata outage')
    const path = String(url)
    metadataPaths.push(path)
    if (path.startsWith('https://registry.npmjs.org/')) {
      const manifest = (target: string, range: string) => ({ name: CODINGNS_PACKAGE_NAME, version: target, gitHead: commit, engines: { dsh: range } })
      return Response.json({ name: CODINGNS_PACKAGE_NAME, 'dist-tags': { latest: '0.2.0-rc.3', next: version },
        versions: { [version]: manifest(version, '>=0.2.0-rc.2'), [longVersion]: manifest(longVersion, '>=0.2.0-rc.2'), '0.2.0-rc.3': manifest('0.2.0-rc.3', '>=0.2.0-rc.2'), [incompatible]: manifest(incompatible, '<0.2.0-rc.2') },
        time: { [version]: '2026-10-25T00:00:00Z' } })
    }
    const tag = decodeURIComponent(path.split('/').at(-1)!)
    if (path.includes('/git/ref/tags/')) return Response.json({ ref: `refs/tags/${tag}`, object: { type: 'commit', sha: commit } })
    if (path.includes('/releases/tags/')) return Response.json({ tag_name: tag, name: `Fixture ${tag}`, body, published_at: '2026-10-25T00:00:00Z' })
    throw new Error('Unexpected fixture metadata URL')
  }
  const installs: { spec: string; options: any }[] = []
  let finishInstall: ((outcome: unknown) => void) | undefined
  let installedVersion = CODINGNS_VERSION
  const profile = { name: 'web' }
  const owner = { id: 'fixture-owner', principal: { kind: 'owner' } }
  const connection = {
    browserPeer: owner,
    admit: ({ headers }: { headers: IncomingMessage['headers'] }) => headers.cookie === 'fixture-owner=yes'
      ? { peer: owner } : { rejection: 403 },
    fetch: { register: () => () => {} },
  }
  const host = { connection, profileContext: profile, pluginManager: {
    async listBundles() { return [{ name: CODINGNS_PACKAGE_NAME, version: installedVersion, installed: true, enabled: true, availability: 'profile' }] },
    async installBundle(spec: string, options: any) {
      installs.push({ spec, options })
      return new Promise(resolve => { finishInstall = resolve })
    },
    async cancelInstall(id: string) {
      assert.equal(id, installs.at(-1)!.options.requestId)
      finishInstall!({ application: 'cancelled', stage: 'install', changed: false, packageResult: { exitCode: 1 } })
      return { status: 'cancelled' }
    },
  } }
  const rpc = new CodingNsRpcTable()
  const modules = new FeatureRegistry({ rpc, dshContext: host, dshVersion: '0.2.1-rc.2' } as never)
  modules.register(createPluginUpdateFeature({ request }))
  await modules.start('pluginUpdate')
  t.after(() => modules.disable('pluginUpdate'))
  let channel!: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  let dispose!: () => Promise<void>
  registerCodingNsRpc({
    connection,
    effect(factory: () => () => Promise<void>) { dispose = factory() },
    webServer: { register(route: { handler: typeof channel }) { channel = route.handler; return () => {} } },
  } as never, rpc)
  t.after(() => dispose())
  const server = createServer(async (incoming, response) => {
    try {
      if (incoming.url?.startsWith('/codingns/')) { await channel(incoming, response); return }
      if (incoming.url === '/panel.js') {
        response.setHeader('Content-Type', 'text/javascript')
        response.end(await readFile(join(outDir, 'plugin-update-panel.iife.js'))); return
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.setHeader('Set-Cookie', 'fixture-owner=yes; HttpOnly; SameSite=Strict; Path=/')
      response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--dsw-alias-bg-layer-1:#fff;--dsw-alias-bg-layer-2:#f7f8fa;--dsw-alias-label-primary:#20252a;--dsw-alias-label-secondary:#666;--dsw-alias-border-l2:#bbb;--dsw-alias-button-info-fill:#3478c4;--dsw-specific-input-major:#f6f7f9;--dsw-radius-md:10px;--dsw-radius-sm:6px;--dsw-focus-ring-width:2px}body{margin:0;padding:16px;box-sizing:border-box;font:14px sans-serif;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}#root{max-width:960px;margin:auto}button,input,select{font:inherit}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--dsw-alias-bg-layer-1:#202124;--dsw-alias-bg-layer-2:#292a2d;--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#b9bdc3;--dsw-alias-border-l2:#52565c;--dsw-alias-button-info-fill:#85b7ff;--dsw-specific-input-major:#292a2d}}</style><div id="root"></div><script src="/panel.js"></script>')
    } catch (error) { response.statusCode = 500; response.end(String(error)) }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const mutate = async (headers: Record<string, string>) => {
    const response = await fetch(`${origin}/codingns/update/apply`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ type: 'client-request', rpcId: 'denied', method: 'update/apply', payload: { version, confirmation: true } }) })
    return response
  }
  assert.equal((await mutate({ Origin: origin })).status, 403)
  const crossOrigin = await mutate({ Cookie: 'fixture-owner=yes', Origin: 'https://untrusted.test' })
  assert.equal((await crossOrigin.json()).result.error.code, 'UPDATE_LOCAL_OWNER_REQUIRED')
  assert.equal(installs.length, 0)

  const { evaluate, command } = browser
  await command('Page.enable')
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await command('Page.addScriptToEvaluateOnNewDocument', { source: 'window.fixtureErrors=[];addEventListener("error",e=>window.fixtureErrors.push(e.message));addEventListener("unhandledrejection",e=>window.fixtureErrors.push(String(e.reason)))' })
  const wait = (expression: string) => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+8000;const check=()=>(document.body&&(${expression}))?resolve(true):Date.now()>end?reject(new Error(document.body?.innerText+" "+JSON.stringify(window.fixtureErrors))):setTimeout(check,25);check()})`)
  const click = (...labels: string[]) => evaluate(`(()=>{const labels=${JSON.stringify(labels)};const b=[...document.querySelectorAll("button")].find(b=>labels.includes(b.textContent));if(!b||b.disabled)throw new Error("Unavailable button "+labels.join(" / "));b.click()})()`)
  const select = (value: string) => evaluate(`(()=>{const s=document.querySelector("select");s.value=${JSON.stringify(value)};s.dispatchEvent(new Event("change",{bubbles:true}))})()`)
  const check = async () => { await click('Check for updates', '检查更新'); await wait('!document.querySelector("select").disabled') }
  const hasText = (text: string) => `document.body.innerText.includes(${JSON.stringify(text)})`
  const reviewDisabled = () => evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="Review update").disabled')
  const toggleVersion = () => evaluate('document.querySelector("button.codingns4dsh-settings-promo-version").click()')
  const badge = 'document.querySelector(".codingns4dsh-settings-promo-update-badge")'
  const captures = new URL('../data/build/review/', import.meta.url)
  await mkdir(captures, { recursive: true })
  const capture = async (name: string) => {
    const shot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    await writeFile(new URL(name, captures), Buffer.from(shot.data, 'base64'))
  }
  await command('Page.navigate', { url: origin })
  await wait(badge)
  assert.equal(await evaluate(`${badge}.textContent`), 'New')
  assert.equal(await evaluate(`${badge}.title`), `New version ${version}`)
  assert.equal(await evaluate(`${badge}.scrollWidth<=${badge}.clientWidth`), true)
  assert.equal(await evaluate('document.querySelector("button[aria-expanded]").getAttribute("aria-expanded")'), 'false')
  assert.equal(await evaluate('document.querySelector("select")===null'), true)
  assert.equal(metadataPaths.filter(path => path.startsWith('https://registry.npmjs.org/')).length, 1)
  assert.equal(installs.length, 0)
  await capture('spec001.1-version-collapsed.png')
  const layout = (original = false) => evaluate(`(()=>{
    const scope=document.querySelector(${JSON.stringify(original ? '#fixture-original' : '#fixture-current')});
    const root=scope.querySelector("aside").getBoundingClientRect();
    return Object.fromEntries(["row","brand","headline","version","text","action"].map(name=>{
      const r=scope.querySelector(".codingns4dsh-settings-promo-"+name).getBoundingClientRect();
      return [name,{x:r.x-root.x,y:r.y-root.y,width:r.width,height:r.height}];
    }).concat([["banner",{x:0,y:0,width:root.width,height:root.height}]]));
  })()`)
  const assertLayout = (actual: any, expected: any, label: string) => {
    for (const [part, dimensions] of Object.entries(actual) as [string, Record<string, number>][]) {
      for (const [dimension, value] of Object.entries(dimensions)) {
        assert.ok(Math.abs(value - expected[part][dimension]) < 1, `${label} ${part}.${dimension}: ${value} vs ${expected[part][dimension]}`)
      }
    }
  }
  for (const scenario of [
    { width: 1280, lang: 'en', panel: 960, zoom: 1 },
    { width: 1280, lang: 'zh', panel: 960, zoom: 1 },
    { width: 1280, lang: 'zh', panel: 680, zoom: 1 },
    { width: 800, lang: 'zh', panel: 960, zoom: 1 },
    { width: 660, lang: 'zh', panel: 960, zoom: 1 },
    { width: 1280, lang: 'zh', panel: 960, zoom: 1.5 },
    { width: 390, lang: 'zh', panel: 960, zoom: 1 },
  ]) {
    await command('Emulation.setDeviceMetricsOverride', { width: scenario.width, height: 900, deviceScaleFactor: 1, mobile: scenario.width < 640 })
    await command('Page.navigate', { url: `${origin}/?lang=${scenario.lang}` })
    await wait(badge)
    await evaluate(`document.querySelector("#root").style.maxWidth=${JSON.stringify(`${scenario.panel}px`)};document.body.style.zoom=${JSON.stringify(String(scenario.zoom))}`)
    const withBadge = await layout()
    assertLayout(withBadge, await layout(true), `${JSON.stringify(scenario)} original`)
    if (scenario.width > 640) {
      assert.ok(withBadge.brand.x + withBadge.brand.width <= withBadge.text.x)
      assert.ok(withBadge.text.x + withBadge.text.width <= withBadge.action.x)
      assert.ok(Math.abs(withBadge.brand.y + withBadge.brand.height / 2 - withBadge.action.y - withBadge.action.height / 2) < 1)
    }
    assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
    await capture(`spec001.1-layout-${scenario.lang}-${scenario.width}-${scenario.panel}-${scenario.zoom}.png`)
    await toggleVersion()
    if (scenario.lang === 'zh') {
      await wait(hasText('运行中的 Host：'))
      assert.equal(await evaluate(hasText('Running Host:')), false)
    }
    await select('latest'); await check()
    await toggleVersion()
    assert.equal(await evaluate(`${badge}===null`), true)
    assertLayout(await layout(), withBadge, `${JSON.stringify(scenario)} badge removed`)
    await toggleVersion()
    await select('exact')
    await evaluate(`(()=>{const i=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(i,${JSON.stringify(longVersion)});i.dispatchEvent(new Event("input",{bubbles:true}))})()`)
    await check()
    await wait(badge)
    assert.equal(await evaluate(`${badge}.title`), scenario.lang === 'zh' ? `新版本 ${longVersion}` : `New version ${longVersion}`)
    await toggleVersion()
    assertLayout(await layout(), withBadge, `${JSON.stringify(scenario)} long version badge`)
  }
  await command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await command('Page.navigate', { url: origin })
  await wait(badge)
  await toggleVersion()
  await wait(hasText('Installed package:'))
  assert.equal(await evaluate('document.querySelector("button[aria-expanded]").getAttribute("aria-expanded")'), 'true')
  assert.equal(await evaluate('document.querySelector("aside").contains(document.querySelector("select"))'), true)
  await select('latest'); await check()
  await wait(hasText('This channel is older than the running or installed version.'))
  assert.equal(await reviewDisabled(), true)
  assert.equal(await evaluate(`${badge}===null`), true)
  await select('next'); await check()
  await wait(hasText('A newer version is available.'))
  await toggleVersion()
  assert.equal(await evaluate('document.querySelector(".codingns4dsh-settings-promo-update-details").hidden'), true)
  await toggleVersion()
  assert.equal(await evaluate('document.querySelector("select").value'), 'next')
  assert.equal(await evaluate('document.querySelector("pre").textContent'), body)
  assert.equal(await evaluate('window.releaseExecuted'), undefined)
  assert.equal(await evaluate('document.querySelector("pre script")!==null'), false)
  assert.ok(metadataPaths.some(path => path.endsWith(`/git/ref/tags/v${version}`)))
  assert.ok(metadataPaths.some(path => path.endsWith(`/releases/tags/v${version}`)))
  offline = true
  await check(); await wait('document.querySelector("[role=alert]")')
  assert.equal(await evaluate('document.querySelector("pre").textContent'), body)
  assert.equal(await reviewDisabled(), true)
  assert.equal(await evaluate(`${badge}.title`), `New version ${version}`)
  offline = false
  await select('exact')
  await evaluate(`(()=>{const i=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(i,${JSON.stringify(incompatible)});i.dispatchEvent(new Event("input",{bubbles:true}))})()`)
  await check(); await wait(hasText('This target is incompatible with the running DSH.'))
  assert.equal(await reviewDisabled(), true)
  await select('next'); await check()
  await click('Review update')
  await wait('document.querySelector("[role=group]")')
  assert.equal(installs.length, 0)
  assert.equal(await evaluate(`document.querySelector("[role=group]").textContent.includes(${JSON.stringify(version)})`), true)
  await capture('spec001.1-update-desktop.png')
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
  await capture('spec001.1-version-dark.png')
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'), true)
  await capture('spec001.1-update-mobile.png')
  await click('Confirm and update'); await wait(hasText('Installing through DSH...'))
  assert.equal(installs.length, 1)
  assert.equal(installs[0]!.spec, `${CODINGNS_PACKAGE_NAME}@${version}`)
  assert.equal(installs[0]!.options.saveExact, true)
  await command('Page.reload')
  await wait('document.querySelector("button[aria-expanded]")')
  await toggleVersion()
  await wait(hasText('Installing through DSH...'))
  assert.equal(installs.length, 1)
  await click('Request cancellation'); await wait(hasText('DSH cancelled the update.'))
  await wait(hasText('Profile files restored by DSH'))
  await check(); await click('Review update'); await click('Confirm and update')
  await wait(hasText('Installing through DSH...'))
  assert.equal(installs.length, 2)
  installedVersion = version
  finishInstall!({ application: 'restart-required', bundle: CODINGNS_PACKAGE_NAME, version, changed: true, stage: 'enable' })
  await click('Refresh operation status')
  await wait(hasText('Package installed; restart required to activate the code.'))
  await wait(hasText('Installed package:'))
  assert.equal(await evaluate(`${badge}===null`), true)
  assert.equal(await evaluate(hasText(CODINGNS_VERSION)), true)
  assert.equal(await evaluate(hasText(CODINGNS_VERSION)), true)
  assert.equal(await evaluate(hasText('Host and Client are active at the target version.')), false)
  profile.name = 'desktop'
  await check(); await wait(hasText('UPDATE_DESKTOP_UNSUPPORTED'))
  assert.equal(await reviewDisabled(), true)
  assert.equal(installs.length, 2)
  assert.deepEqual(await evaluate('window.fixtureErrors'), [])
})
