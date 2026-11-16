import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createServer } from 'node:http'
import { headlessBrowser } from './headless-browser-driver.js'
import { buildSubagentPreview } from '../scripts/preview-zcode-subagents.mjs'

test('原生风格浮层：已结束折叠、键盘退出、详情返回、主题与窄屏', { timeout: 90_000 }, async t => {
  const html = await readFile(await buildSubagentPreview())
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const browser = await headlessBrowser(t, ['--no-sandbox', '--disable-crash-reporter', '--disable-breakpad'], { keepProfile: true })
  if (!browser) return
  await browser.command('Page.bringToFront')
  const until = async (expression: string) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) { if (await browser.evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 30)) }
    assert.fail(`${expression}: ${await browser.evaluate('document.body.innerText')}`)
  }
  await browser.command('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 2, mobile: false })
  await browser.command('Page.navigate', { url: `http://127.0.0.1:${address.port}` })
  await until('document.querySelectorAll("[data-codingns-agent-row]").length===7')
  assert.equal(await browser.evaluate('!!document.querySelector("dialog:modal")'), false, '概览为非模态浮层')
  assert.equal(await browser.evaluate('document.querySelectorAll("[data-codingns-subagent-kind=native] [data-codingns-agent-row]").length'), 2)
  assert.equal(await browser.evaluate('document.querySelector("[data-codingns-ended-agents] button").getAttribute("aria-expanded")'), 'false')
  assert.equal(await browser.evaluate('document.querySelector("[data-codingns-subagent-run=workflow-history]").dataset.open'), 'false')
  const shots = resolve(process.env.ZCODE_SUBAGENT_SCREENSHOTS ?? '.agent-temp/zcode-preview/screenshots')
  await mkdir(shots, { recursive: true })
  const capture = async (name: string) => { const image = await browser.command('Page.captureScreenshot', { format: 'png' }); await writeFile(join(shots, name + '.png'), Buffer.from(image.data, 'base64')) }
  const capturePanel = async (name: string) => {
    const rect = await browser.evaluate('(() => { const r=document.querySelector(".codingns-subagents-menu").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1} })()')
    const image = await browser.command('Page.captureScreenshot', { format: 'png', clip: rect })
    await writeFile(join(shots, name + '.png'), Buffer.from(image.data, 'base64'))
  }
  await capture('mixed-dark')
  await capturePanel('mixed-panel')
  await browser.evaluate('document.querySelector("[data-codingns-ended-agents] button").click();window.preview.refresh()')
  await until('document.querySelectorAll("[data-codingns-subagent-kind=native] [data-codingns-agent-row]").length===7')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(await browser.evaluate('document.querySelector("[data-codingns-ended-agents] button").getAttribute("aria-expanded")'), 'true', '轮询保留手动展开')
  await browser.evaluate('document.querySelector("[data-codingns-agent-row=native-1]").click()')
  await until('!!document.querySelector("dialog:modal [data-codingns-subagent-entry]")')
  await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await until('!document.querySelector("dialog:modal")')
  assert.equal(await browser.evaluate('document.querySelector("[data-codingns-ended-agents] button").getAttribute("aria-expanded")'), 'true', '详情返回保留展开选择')
  await browser.evaluate('document.querySelector("[data-codingns-ended-agents] button").click()')
  for (const width of [1280, 768, 390, 320]) {
    await browser.command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 2, mobile: width < 460 })
    await new Promise(resolve => setTimeout(resolve, 100))
    const layout = await browser.evaluate(`(() => { const panel=document.querySelector('.codingns-subagents-menu'), content=panel.querySelector('.codingns-subagents__dialogcontent'), rect=panel.getBoundingClientRect(); return {left:rect.left,right:rect.right,width:innerWidth,overflow:panel.scrollWidth>panel.clientWidth+1||content.scrollWidth>content.clientWidth+1,visible:[...panel.querySelectorAll('[data-codingns-agent-row]')].every(row=>{ const r=row.getBoundingClientRect();return r.width>100&&r.height>=44 })} })()`)
    assert.ok(layout.left >= 0 && layout.right <= width + 1 && !layout.overflow && layout.visible, JSON.stringify(layout))
    const rows = await browser.evaluate(`(() => {const grid=document.querySelector('[data-codingns-parallel]');return [...grid.children].map(item=>{const r=item.getBoundingClientRect();return {left:r.left,top:Math.round(r.top),width:r.width,right:r.right,bottom:r.bottom}})})()`)
    const perRow = width === 1280 ? 3 : width === 768 ? 2 : 1
    assert.equal(rows.filter((row: any) => row.top === rows[0].top).length, perRow, `并行列数 @${width}`)
    assert.ok(rows[perRow].top > rows[0].top, `超出一行后自动换行 @${width}`)
    assert.ok(rows.every((row: any) => row.right <= width && row.width > 200), `卡片可读且无溢出 @${width}`)
    if (width >= 768) { await capturePanel(`workflow-grid-${perRow}col`); }
    if (width === 390) await capture('mixed-mobile')
  }
  await browser.command('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 2, mobile: false })
  await browser.evaluate('document.body.removeAttribute("data-ds-dark-theme")')
  await capture('mixed-light')
  await browser.evaluate('document.body.setAttribute("data-ds-dark-theme","");window.preview.setMode("native")')
  await until('document.querySelectorAll("[data-codingns-subagent-group]").length===1 && !!document.querySelector("[data-codingns-subagent-group=native]")')
  await capture('native-dark')
  await capturePanel('native-panel')
  await browser.evaluate('window.preview.setMode("workflow")')
  await until('document.querySelectorAll("[data-codingns-subagent-group]").length===1 && !!document.querySelector("[data-codingns-subagent-group=workflow]")')
  await capture('workflow-dark')
  await capturePanel('workflow-panel')
  await browser.command('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 2, mobile: false })
  await new Promise(resolve => setTimeout(resolve, 100))
  await capturePanel('workflow-grid-preview')
  await browser.evaluate('document.querySelector("[data-codingns-agent-row=actor-3]").click()')
  await until('!!document.querySelector("dialog:modal [data-codingns-subagent-agent=actor-3]")')
  await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await until('!document.querySelector("dialog:modal")')
  await browser.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await browser.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
  await until('!document.querySelector("dialog")')
  await browser.evaluate('document.querySelector("[data-codingns-subagent-trigger]").click()')
  await until('!!document.querySelector("dialog[open]")')
  await browser.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 })
  await browser.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 })
  await until('!document.querySelector("dialog")')
  assert.ok(await browser.evaluate('window.preview.requests.every(endpoint=>["subagent/state","subagent/agent","session/get"].some(suffix=>endpoint.endsWith(suffix)))'), '预览只能读状态，不调用启动/继续接口')
  await browser.evaluate('window.preview.dispose()')
})
