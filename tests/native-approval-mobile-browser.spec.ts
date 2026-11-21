import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { build } from 'tsdown'
import { headlessBrowser } from './headless-browser-driver.js'

test('native permission menu opens by touch while running/queued, saves for next turn, and retains risk confirmation', { timeout: 60_000 }, async t => {
  const nativeSource = process.env.DSH_NATIVE_PERMISSION_SOURCE
  if (!nativeSource) { t.skip('Set DSH_NATIVE_PERMISSION_SOURCE to the installed DSH PermissionSelect bundle.'); return }
  const output = process.env.DSH_APPROVAL_ARTIFACTS ?? await mkdtemp(join(tmpdir(), 'approval-browser-'))
  await mkdir(output, { recursive: true })
  const bundleDir = await mkdtemp(join(tmpdir(), 'approval-browser-bundle-'))
  await build({ config: false, entry: ['tests/fixtures/native-approval-browser.ts'], outDir: bundleDir, platform: 'browser', target: 'es2022', format: 'iife', clean: false, dts: false, sourcemap: false,
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' }, loader: { '.png': 'dataurl', '.svg': 'dataurl' }, deps: { alwaysBundle: () => true, onlyBundle: false },
    plugins: [{ name: 'native-permission-source', resolveId(id: string) { if (id.endsWith('native-permission.js?raw')) return '\0native-permission' }, async load(id: string) { if (id === '\0native-permission') return `export default ${JSON.stringify(await readFile(nativeSource, 'utf8'))}` } }],
  })
  const bundle = await readFile(join(bundleDir, 'native-approval-browser.iife.js'))
  const css = await readFile(join(bundleDir, 'style.css'))
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>:root{color-scheme:dark;--dsw-alias-label-primary:#e6e6e6;--dsw-alias-label-secondary:#b3b3b3;--dsw-alias-label-tertiary:#8c8c8c;--dsw-menu-surface-fill:#303030;--dsw-menu-backdrop-filter:none;--dsw-alias-bg-layer-2:#303030;--dsw-alias-bg-mask-1:rgba(0,0,0,.5);--dsw-radius-panel:16px;--dsw-radius-lg:12px;--dsw-alias-bg-base:#202020;--dsw-alias-bg-module:#303030;--dsw-alias-bg-module-platform:#303030;--dsw-alias-interactive-bg-hover:#3c3c3c;--dsw-alias-border-l2:#444;--dsw-alias-border-l3:#404040;--dsw-alias-state-business-primary:#4d9dff;--dsw-radius-md:8px}*{box-sizing:border-box}body{margin:0;padding:12px;font:14px 'Segoe UI','Microsoft YaHei',sans-serif;background:#202020;color:#e6e6e6}.caption{font-size:18px}.composer{position:relative;margin-top:300px;width:100%;border:1px solid #444;border-radius:16px;background:#2b2b2b;padding:14px;container-type:inline-size}.input{height:65px;color:#888}.toolbar{display:inline-flex;align-items:center}.agent{position:absolute;right:14px;bottom:24px;color:#c7c7c7}button{font:inherit}</style><div id="root"></div><script src="/fixture.js"></script>`
  const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript; charset=utf-8' : req.url === '/style.css' ? 'text/css' : 'text/html; charset=utf-8'); res.end(req.url === '/fixture.js' ? bundle : req.url === '/style.css' ? css : html) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(() => server.close())
  const browser = await headlessBrowser(t, [], { keepProfile: true }); assert.ok(browser)
  await browser.command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  const until = async (expression: string) => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (await browser.evaluate(`Boolean(${expression})`)) return; await new Promise(done => setTimeout(done, 30)) } assert.fail(`${expression}; ${await browser.evaluate('document.body.innerText')}`) }
  const tap = async (expression: string) => {
    const point = await browser.evaluate(`(() => {const e=${expression}; if(!e) throw new Error('Missing touch target'); const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    await browser.command('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] })
    await browser.command('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  const screenshot = async (name: string) => { const result = await browser.command('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, name + '.png'), Buffer.from(result.data, 'base64')) }
  const address = server.address() as any
  const checks: unknown[] = []
  for (const width of [320, 360, 390, 430, 768, 1280]) {
    await browser.command('Emulation.setDeviceMetricsOverride', { width, height: 732, deviceScaleFactor: 1, mobile: width < 768 })
    await browser.command('Page.navigate', { url: `http://127.0.0.1:${address.port}` })
    await until('document.querySelector("[data-codingns-approval]") && document.querySelector(".toolbar button") && document.querySelector(".toolbar button").textContent.includes("人工审批")')
    assert.equal(await browser.evaluate('document.querySelector(".toolbar button").disabled'), false)
    assert.equal(await browser.evaluate('document.querySelector("[data-codingns-approval]").dataset.codingnsApprovalApplies'), 'next-turn')
    if (width < 768) assert.ok(await browser.evaluate('document.querySelector(".toolbar button").getBoundingClientRect().height') >= 44, await browser.evaluate('document.querySelector("[data-codingns-approval]").outerHTML'))
    await tap('document.querySelector(".toolbar button")')
    await until('document.querySelector("[role^=menuitem]")')
    assert.equal(await browser.evaluate('document.querySelectorAll("[role^=menuitem]").length'), 5)
    assert.equal(await browser.evaluate('document.body.innerText.includes("跟随 DSH")'), false)
    assert.equal(await browser.evaluate('document.body.innerText.includes("自动接受编辑")'), false)
    if (width === 360) await screenshot('running-menu-360')
    await tap('[...document.querySelectorAll("[role^=menuitem]")].find(e=>e.textContent.includes("只读"))')
    await until('window.fixture.calls.length === 1 && document.querySelector(".toolbar button").textContent.includes("只读")')
    assert.equal(await browser.evaluate('window.fixture.calls[0].nativeApprovalMode'), 'read-only')
    assert.equal(await browser.evaluate('document.querySelectorAll(".toolbar button").length'), 1)
    if (width === 360) {
      await screenshot('saved-next-turn-360')
      await tap('document.querySelector(".toolbar button")')
      await until('document.querySelector("[role^=menuitem]")')
      await tap('[...document.querySelectorAll("[role^=menuitem]")].find(e=>e.textContent.includes("自动审查"))')
      await until('document.querySelector("dialog") || document.querySelector("[role=dialog]")')
      assert.equal(await browser.evaluate('window.fixture.calls.length'), 1, 'risk confirmation must happen before saving')
      await screenshot('native-risk-confirmation-360')
      await tap('[...document.querySelectorAll("[role=dialog] button")].find(e=>e.textContent.trim()==="取消")')
      await until('!document.querySelector("[role=dialog]")')
      assert.equal(await browser.evaluate('window.fixture.calls.length'), 1, 'cancelling auto review cannot save a mode')
      await tap('document.querySelector(".toolbar button")')
      await until('document.querySelector("[role^=menuitem]")')
      await tap('[...document.querySelectorAll("[role^=menuitem]")].find(e=>e.textContent.trim()==="完全访问")')
      await until('document.querySelector("[role=dialog]")')
      const confirm = '[...document.querySelectorAll("[role=dialog] button")].at(-1)'
      assert.equal(await browser.evaluate(`${confirm}.disabled`), true, 'full access requires acknowledgement')
      assert.equal(await browser.evaluate('window.fixture.calls.length'), 1)
      await screenshot('full-access-confirmation-360')
      await tap('document.querySelector("[role=dialog] input[type=checkbox]")')
      await until(`!${confirm}.disabled`)
      await tap(confirm)
      await until('window.fixture.calls.length === 2 && !document.querySelector("[role=dialog]")')
      assert.equal(await browser.evaluate('window.fixture.calls[1].nativeApprovalMode'), 'full-access')
      await tap('document.querySelector(".toolbar button")')
      await until('document.querySelector("[role^=menuitem]")')
      await tap('[...document.querySelectorAll("[role^=menuitem]")].find(e=>e.textContent.includes("危险操作需确认"))')
      await until('document.querySelector("[role=dialog]")')
      assert.match(await browser.evaluate('document.querySelector("[role=dialog]").textContent'), /不受文件沙箱限制/u)
      assert.equal(await browser.evaluate(`${confirm}.disabled`), true)
      assert.equal(await browser.evaluate('window.fixture.calls.length'), 2)
      await tap('[...document.querySelectorAll("[role=dialog] button")].find(e=>e.textContent.trim()==="取消")')
      await until('!document.querySelector("[role=dialog]")')
      assert.equal(await browser.evaluate('window.fixture.calls.length'), 2)
      await tap('document.querySelector(".toolbar button")')
      await until('document.querySelector("[role^=menuitem]")')
      await tap('[...document.querySelectorAll("[role^=menuitem]")].find(e=>e.textContent.includes("危险操作需确认"))')
      await until('document.querySelector("[role=dialog]")')
      await screenshot('full-access-confirm-360')
      await tap('document.querySelector("[role=dialog] input[type=checkbox]")')
      await until(`!${confirm}.disabled`)
      await tap(confirm)
      await until('window.fixture.calls.length === 3 && !document.querySelector("[role=dialog]")')
      assert.equal(await browser.evaluate('window.fixture.calls[2].nativeApprovalMode'), 'full-access-confirm')
    }
    checks.push({ width, touchMenu: true, saveDuringRun: true, singleEntry: true })
  }
  await browser.command('Emulation.setDeviceMetricsOverride', { width: 360, height: 732, deviceScaleFactor: 1, mobile: true })
  await browser.command('Page.reload')
  await until('window.fixture && document.querySelector("button")')
  await browser.evaluate('window.fixture.render("zcode", false, true)')
  await until('document.querySelector(".toolbar button").textContent.includes("人工审批")')
  await tap('document.querySelector(".toolbar button")')
  await until('document.body.innerText.includes("自动接受编辑")')
  assert.equal(await browser.evaluate('document.querySelectorAll("[role^=menuitem]").length'), 5)
  assert.equal(await browser.evaluate('document.body.innerText.includes("跟随 DSH")'), false)
  await tap('[...document.querySelectorAll("[role^=menuitem]")].find(e=>e.textContent.includes("自动接受编辑"))')
  await until('window.fixture.calls.length === 1')
  assert.equal(await browser.evaluate('window.fixture.calls[0].adapterId'), 'zcode')
  assert.equal(await browser.evaluate('window.fixture.calls[0].nativeApprovalMode'), 'accept-edits')
  assert.equal(await browser.evaluate('document.querySelector("[data-codingns-approval]").dataset.codingnsApprovalApplies'), 'next-turn')
  await screenshot('queued-zcode-saved-360')
  await browser.evaluate('window.fixture.render("antigravity", false, false)')
  await until('document.querySelector(".toolbar button").textContent.includes("默认")')
  await tap('document.querySelector(".toolbar button")')
  await until('document.querySelector("[role^=menuitem]")')
  assert.equal(await browser.evaluate('document.querySelectorAll("[role^=menuitem]").length'), 4)
  await tap('[...document.querySelectorAll("[role^=menuitem]")].find(e=>e.textContent.includes("完全访问"))')
  await until('document.querySelector("[role=dialog]")')
  assert.match(await browser.evaluate('document.querySelector("[role=dialog]").textContent'), /agy/)
  await screenshot('agy-risk-confirmation-360')
  const receipt = { checkedAt: new Date().toISOString(), checks, queuedZcodeSaved: true, nativeRiskConfirmation: true, fullAccessAcknowledgement: true, fullAccessConfirmAcknowledgement: true, agyRiskConfirmation: true, physicalPhoneVerified: false, modelCalls: 0 }
  await writeFile(join(output, 'browser-validation.json'), JSON.stringify(receipt, null, 2))
  t.diagnostic(JSON.stringify(receipt))
})
