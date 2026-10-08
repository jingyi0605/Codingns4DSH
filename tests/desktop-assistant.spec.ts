import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { Script } from 'node:vm'
import { createServer, get as httpGet, request as httpRequest } from 'node:http'
import { DesktopAssistantController } from '../src/host/desktop-assistant/controller.js'
import type { DesktopAssistantControllerOptions } from '../src/host/desktop-assistant/controller.js'
import { openDesktopAssistantPage } from '../src/host/desktop-assistant/server.js'
import { handleDesktopAssistantRequest } from '../src/host/desktop-assistant/feature.js'
import { isDesktopAssistantHost, readDesktopAssistantPresentation, clampDesktopAssistantBounds, DESKTOP_ASSISTANT_CHANNEL } from '../src/shared/desktop-assistant.js'
import { isDesktopAssistantClient, connectDesktopAssistant } from '../src/client/avatar/desktop-bridge.js'
import { BUILTIN_ASSISTANT_AVATAR } from '../src/shared/assistant-avatar.js'
import { buildMacAssistantScript } from '../src/host/desktop-assistant/mac-agent.js'
import { buildWinAssistantScript } from '../src/host/desktop-assistant/win-agent.js'
import { observeDesktopAssistantProcess } from '../src/host/desktop-assistant/process.js'
import { DesktopAssistantAvatar } from '../src/client/avatar/desktop-view.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { createElement, isValidElement } from 'react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const owner = 'companion:test-owner'
const presentation = { visible: true, state: 'idle' as const, caption: '', label: '打开助理' }
const frame = { ...presentation, model: BUILTIN_ASSISTANT_AVATAR, size: 144 }
function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  return isValidElement(node) ? [node, ...elements((node.props as any).children)] : []
}
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await delay(2) }
  assert.fail('等待条件未满足')
}
function fixture(overrides: Partial<DesktopAssistantControllerOptions> = {}) {
  let events: (event: Record<string, unknown>) => void = () => {}
  let exited = () => {}
  let launches = 0, closes = 0, stops = 0, allowed = true
  const commands: Record<string, unknown>[] = []
  const controller = new DesktopAssistantController({ supported: true,
    readFrame: (value) => allowed ? { ...frame, ...value } : undefined,
    openPage: async () => ({ url: 'http://127.0.0.1:12345/?token=test', close: async () => { closes++ } }),
    launch: async (onEvent, onExit) => {
      launches++; events = onEvent; exited = onExit
      return { send: (command) => { commands.push(command) }, stop: async () => { stops++; onExit() } }
    }, deadlineMs: 1000, ...overrides })
  return { controller, commands, event: (event: Record<string, unknown>) => events(event), exit: () => exited(),
    counts: () => ({ launches, closes, stops }), disable: () => { allowed = false } }
}

test('双端识别：只有官方 Desktop Host 与 Desktop 页面进入原生路径', () => {
  for (const platform of ['darwin', 'win32']) assert.equal(isDesktopAssistantHost(platform, '40.0', '1', 'C:\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js'), true)
  for (const input of [ ['linux', '40', '1', '/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'],
    ['darwin', undefined, '1', '/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'], ['darwin', '40', '1', '/stage0/index.js'] ] as const) {
    assert.equal(isDesktopAssistantHost(...input), false)
  }
  assert.equal(isDesktopAssistantClient({ location: { protocol: 'https:' } }), false)
  assert.equal(isDesktopAssistantClient({ location: { protocol: 'dsh-app:' } }), true)
  assert.equal(isDesktopAssistantClient({ dshDesktopBoot: {} }), true)
})

test('快照过滤任意扩展字段，拒绝非法状态和过大字幕', () => {
  assert.deepEqual(readDesktopAssistantPresentation({ ...presentation, url: 'file:///secret', command: 'run' }), presentation)
  for (const input of [null, { ...presentation, visible: 1 }, { ...presentation, state: 'unknown' }, { ...presentation, caption: 'x'.repeat(8001) }]) {
    assert.throws(() => readDesktopAssistantPresentation(input))
  }
})

test('多屏坐标支持负数；显示器移除后位置回到有效工作区', () => {
  const screens = [{ x: 0, y: 24, width: 1920, height: 1056 }, { x: -1280, y: 0, width: 1280, height: 1024 }]
  assert.equal(clampDesktopAssistantBounds({ x: -200, y: 950, width: 144, height: 156 }, screens).y, 868)
  assert.deepEqual(clampDesktopAssistantBounds({ x: -1200, y: 900, width: 144, height: 156 }, screens.slice(0, 1)), { x: 0, y: 900, width: 144, height: 156 })
})

test('原生显示确认与启动完成分开，多次并发更新只启动一个进程', async () => {
  const f = fixture(); f.controller.attach(owner)
  const first = f.controller.update(owner, 1, presentation)
  const second = f.controller.update(owner, 2, { ...presentation, state: 'speaking' })
  await until(() => f.commands.some((command) => command.cmd === 'load'))
  assert.equal(f.controller.status(owner).visible, false)
  f.event({ ev: 'loaded' }); await Promise.all([first, second])
  assert.equal(f.controller.status(owner).visible, false)
  f.event({ ev: 'shown' }); assert.equal(f.controller.status(owner).visible, true)
  assert.equal(f.counts().launches, 1)
  await f.controller.dispose(); assert.deepEqual(f.counts(), { launches: 1, closes: 1, stops: 1 })
})

test('停用与就绪竞争：迟到事件和旧请求不能重新显示窗口', async () => {
  const f = fixture(); f.controller.attach(owner)
  const pending = f.controller.update(owner, 1, presentation)
  await until(() => f.commands.some((command) => command.cmd === 'load'))
  f.disable(); await f.controller.refresh(); await pending
  f.event({ ev: 'loaded' }); f.event({ ev: 'shown' })
  assert.equal(f.controller.status(owner).visible, false)
  assert.equal(f.controller.status(owner).error, undefined)
  assert.ok(!f.commands.some((command) => command.cmd === 'show'))
  await f.controller.dispose()
})

test('原生点击与重复状态同步不隐藏窗口，只有显式关闭才隐藏', async () => {
  const f = fixture(); f.controller.attach(owner)
  const pending = f.controller.update(owner, 1, presentation)
  await until(() => f.commands.some((command) => command.cmd === 'load')); f.event({ ev: 'loaded' }); await pending; f.event({ ev: 'shown' })
  f.event({ ev: 'open' })
  const before = f.commands.filter((command) => command.cmd === 'hide').length
  await f.controller.update(owner, 2, presentation)
  assert.equal(f.commands.filter((command) => command.cmd === 'hide').length, before)
  assert.equal(f.controller.status(owner).visible, true)
  assert.equal(f.controller.status(owner).openSequence, 1)
  await f.controller.update(owner, 3, { ...presentation, visible: false })
  assert.equal(f.controller.status(owner).visible, false)
  assert.equal(f.commands.filter((command) => command.cmd === 'hide').length, before + 1)
  await f.controller.update(owner, 4, presentation)
  f.event({ ev: 'shown' }); assert.equal(f.controller.status(owner).visible, true)
  assert.equal(f.counts().launches, 1, '打开与关闭工作台无需重建原生进程')
  await f.controller.dispose()
})

test('原生启动等待仍可用，不支持当前形象时明确允许页面回退', async () => {
  const f = fixture(); f.controller.attach(owner)
  const pending = f.controller.update(owner, 1, presentation)
  await until(() => f.commands.some((command) => command.cmd === 'load'))
  assert.equal(f.controller.status(owner).available, true)
  assert.equal(f.controller.status(owner).visible, false)
  f.event({ ev: 'loaded' }); await pending
  f.disable(); await f.controller.refresh()
  assert.equal(f.controller.status(owner).available, false)
  await f.controller.dispose()
})

test('页面刷新后旧 owner 的更新和卸载不能干扰新 owner', async () => {
  const f = fixture(); f.controller.attach(owner); f.controller.attach('companion:new-owner')
  await f.controller.update(owner, 100, presentation); await f.controller.detach(owner)
  assert.equal(f.counts().launches, 0)
  assert.equal(f.controller.status('companion:new-owner').owned, true)
  await f.controller.dispose()
})

test('启动超时、异常退出和资源失败都回退，轮询不会循环拉起崩溃进程', async () => {
  const f = fixture({ deadlineMs: 10 }); f.controller.attach(owner)
  await f.controller.update(owner, 1, presentation)
  assert.match(f.controller.status(owner).error!, /超时/u)
  await f.controller.update(owner, 2, presentation)
  assert.equal(f.counts().launches, 1)
  await f.controller.dispose()
  const g = fixture(); g.controller.attach(owner)
  const pending = g.controller.update(owner, 1, presentation)
  await until(() => g.commands.some((command) => command.cmd === 'load')); g.event({ ev: 'loaded' }); await pending
  g.event({ ev: 'shown' }); g.exit()
  assert.equal(g.controller.status(owner).visible, false); assert.match(g.controller.status(owner).error!, /退出/u)
  await g.controller.dispose()
  const h = fixture({ openPage: async () => { throw new Error('bundle missing') } }); h.controller.attach(owner)
  await h.controller.update(owner, 1, presentation)
  assert.equal(h.counts().launches, 0); assert.equal(h.controller.status(owner).error, 'bundle missing')
  await h.controller.dispose()
})

test('原生页面采用一次性实例令牌和固定资源路由，不开放 DSH RPC', async () => {
  const requests: string[] = []
  const page = await openDesktopAssistantPage({ frame: () => frame, readBundle: async () => '/* 测试入口 */',
    assets: async (request) => { requests.push(new URL(request.url).pathname); return new Response(null, { status: 404 }) } })
  try {
    const origin = new URL(page.url).origin
    assert.equal((await fetch(origin + '/state')).status, 403)
    const bootstrap = await fetch(page.url, { redirect: 'manual' })
    assert.equal(bootstrap.status, 302)
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    assert.match(bootstrap.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/u)
    const headers = { cookie }
    assert.deepEqual(await (await fetch(origin + '/state', { headers })).json(), frame)
    const html = await fetch(origin, { headers }); assert.ok(html.headers.get('content-security-policy')?.includes("frame-src 'none'"))
    assert.equal((await fetch(origin, { headers: { ...headers, origin: 'https://example.com' } })).status, 403)
    // Node fetch 会重写 Host，使用原始 HTTP 请求验证服务端的 Host 边界。
    const forgedHost = await new Promise<number | undefined>((resolve, reject) => {
      httpGet(origin, { headers: { ...headers, host: 'example.com' } }, (response) => { response.resume(); resolve(response.statusCode) }).on('error', reject)
    })
    assert.equal(forgedHost, 403)
    assert.equal((await fetch(origin + '/state', { method: 'POST', headers })).status, 403)
    assert.equal((await fetch(origin + '/codingns/settings', { headers })).status, 404)
    assert.deepEqual(requests, ['/codingns/settings'])
    assert.equal((await fetch(origin + '/renderer.js', { headers })).status, 200)
  } finally { await page.close() }
  await assert.rejects(fetch(page.url))
})

test('控制接口校验 DSH 登录，拒绝 URL 与方法不匹配，分块中文不会乱码', async () => {
  const f = fixture(); let reject = false
  const server = createServer((req, res) => { void handleDesktopAssistantRequest(req, res, () => reject ? 401 : undefined, f.controller) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}${DESKTOP_ASSISTANT_CHANNEL}`
  const request = (action: string, method = action) => fetch(`${base}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload: { ownerId: owner } }) })
  try {
    reject = true; assert.equal((await request('attach')).status, 403)
    reject = false; assert.equal((await (await request('attach')).json()).result.value.owned, true)
    for (const extra of [{ origin: 'http://127.0.0.1' }, { 'x-forwarded-for': '192.168.1.20' }]) {
      assert.equal((await fetch(`${base}/attach`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra } })).status, 403)
    }
    assert.equal((await (await request('attach', 'update')).json()).result.ok, false)
    const body = Buffer.from(JSON.stringify({ type: 'client-request', rpcId: '中文请求', method: 'update',
      payload: { ownerId: owner, sequence: 1, presentation: { ...presentation, visible: false } } }))
    const split = body.indexOf(Buffer.from('中文')) + 1
    const result = await new Promise<any>((resolve, reject) => {
      const req = httpRequest(`${base}/update`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
        let output = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { output += chunk }); res.on('end', () => resolve(JSON.parse(output)))
      }).on('error', reject)
      req.write(body.subarray(0, split)); setTimeout(() => req.end(body.subarray(split)), 5)
    })
    assert.equal(result.rpcId, '中文请求'); assert.equal(result.result.ok, true)
  } finally { await f.controller.dispose(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
})

test('远程控制请求在解析载荷前拒绝，不能创建原生窗口', async () => {
  const f = fixture(); let status = 0
  const response = { writeHead(code: number) { status = code; return this }, end() {} }
  await handleDesktopAssistantRequest({ socket: { remoteAddress: '192.168.1.20' }, headers: {} } as any, response as any, () => undefined, f.controller)
  assert.equal(status, 403); assert.equal(f.counts().launches, 0)
  await f.controller.dispose()
})

test('启动期间先关闭再重新开启不留下孤儿窗口，也不永久锁住启动', async () => {
  const f = fixture(); f.controller.attach(owner)
  const first = f.controller.update(owner, 1, presentation)
  await until(() => f.commands.some((command) => command.cmd === 'load'))
  await f.controller.update(owner, 2, { ...presentation, visible: false }); await first
  const retry = f.controller.update(owner, 3, presentation)
  await until(() => f.counts().launches === 2); f.event({ ev: 'loaded' }); await retry
  f.event({ ev: 'shown' }); assert.equal(f.controller.status(owner).visible, true)
  await f.controller.dispose()
})

test('Client 串行更新，失败后恢复页面，原生点击只打开一次且卸载忽略迟到结果', async () => {
  let active = 0, maxActive = 0, calls = 0, opened = 0, detached = 0, fail = false
  const statuses: boolean[] = []
  const bridge = connectDesktopAssistant({ call: async (_channel, action) => {
    active++; maxActive = Math.max(maxActive, active); await delay(2); active--
    if (action === 'detach') detached++
    if (action === 'update') calls++
    return fail ? { ok: false, error: { code: 'unavailable', message: '失联' } }
      : { ok: true, value: { available: true, owned: true, visible: action === 'update', openSequence: calls > 1 ? 1 : 0 } }
  } }, owner, (status) => statuses.push(status.visible), () => { opened++ }, 3)
  bridge.update(presentation)
  await until(() => calls >= 3)
  assert.equal(opened, 1); assert.equal(maxActive, 1)
  fail = true; await until(() => statuses.at(-1) === false)
  bridge.dispose(); const count = statuses.length
  fail = false; await until(() => detached > 0); await delay(20)
  assert.equal(statuses.length, count)
})

test('Client 短暂断连保留原生状态，重连重新附着且不吞掉期间的点击', async () => {
  let updates = 0, attaches = 0, failures = 0, opened = 0
  const statuses: { visible: boolean; error?: string }[] = []
  const bridge = connectDesktopAssistant({ call: async (_channel, action) => {
    if (action === 'attach') attaches++
    if (action === 'update') {
      updates++
      if (updates === 2 || updates === 3) { failures++; throw new Error('temporary network failure') }
    }
    return { ok: true, value: { available: true, owned: true, visible: true, openSequence: updates >= 2 ? 1 : 0 } }
  } }, owner, (status) => statuses.push(status), () => { opened++ }, 5)
  try {
    bridge.update(presentation)
    await until(() => updates >= 5)
    assert.equal(failures, 2); assert.equal(attaches, 3)
    assert.ok(statuses.length >= 2)
    assert.ok(statuses.every((status) => status.visible && !status.error), '瞬时失败不能使页面再画一份形象')
    assert.equal(opened, 1)
  } finally { bridge.dispose() }
})

test('Client 丢弃显示开关变化前的迟到状态，并立即发送最新值', async () => {
  let finish!: (value: any) => void
  const updates: boolean[] = [], statuses: boolean[] = []
  const bridge = connectDesktopAssistant({ call: async (_channel, action, payload) => {
    if (action !== 'update') return { ok: true, value: { available: true, owned: true, visible: false, openSequence: 0 } }
    updates.push((payload as any).presentation.visible)
    if (updates.length === 1) return new Promise((resolve) => { finish = resolve })
    return { ok: true, value: { available: true, owned: true, visible: true, openSequence: 0 } }
  } }, owner, (status) => statuses.push(status.visible), () => {}, 10000)
  try {
    bridge.update({ ...presentation, visible: false })
    await until(() => updates.length === 1)
    bridge.update(presentation)
    finish({ ok: true, value: { available: false, owned: true, visible: false, openSequence: 0 } })
    await until(() => statuses.length > 0)
    assert.deepEqual(updates, [false, true])
    assert.deepEqual(statuses, [true])
  } finally { bridge.dispose() }
})

test('Host 无错误重建后自动重新附着，已有其他页面持有时不争抢', async () => {
  let attaches = 0, updates = 0
  const bridge = connectDesktopAssistant({ call: async (_channel, action) => {
    if (action === 'attach') attaches++
    if (action === 'update') updates++
    return { ok: true, value: { available: true, owned: updates === 0 || updates === 2,
      attached: updates !== 1, visible: updates === 2, openSequence: 0 } }
  } }, owner, () => {}, () => {}, 3)
  try {
    bridge.update(presentation)
    await until(() => updates >= 5)
    assert.equal(attaches, 2, '仅无人持有的 Host 重建触发一次重新附着')
  } finally { bridge.dispose() }
})

test('双平台原生脚本语法与 Windows 固定 SDK 分发完整', async () => {
  assert.doesNotThrow(() => new Script(buildMacAssistantScript()))
  const windows = buildWinAssistantScript("C:\\测试路径\\it's sdk")
  assert.ok(windows.includes("it''s sdk")); assert.ok(windows.includes('WebView2CompositionControl'))
  assert.ok(!windows.includes('rendererHeader')); assert.ok(!windows.includes('win.Activate()'))
  const expected: Record<string, string> = {
    'Microsoft.Web.WebView2.Core.dll': '50e9c2f516e2f05c4d8ee925018314353b5f8198795f2222a4d433bddfece078',
    'Microsoft.Web.WebView2.Wpf.dll': 'd6d5e8142ca92fede970f132eb1ce8eff99225e5289989db0ab0aea83585d850',
    'x64/WebView2Loader.dll': 'bf2fefaff7fd4775ea1e07328cc3142721943948f16d261fb82cbd978b7f99e2',
    'arm64/WebView2Loader.dll': '118210fd806def002465666e8e03c22e3c4c7d87aef09582655daf5a5572bcf7',
    'x86/WebView2Loader.dll': '88a23a619ee7f2f4d2e476533aeb59b6fef917baa3eecf369a1c14f7446c649c',
  }
  for (const [file, digest] of Object.entries(expected)) assert.equal(createHash('sha256').update(await readFile(new URL(`../assets/desktop-assistant/webview2/${file}`, import.meta.url))).digest('hex'), digest)
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.files.includes('assets/desktop-assistant/**'))
  assert.match(manifest.scripts['bundle:client'], /tsdown.desktop-assistant.config.ts/u)
})

test('原生异常退出保留错误原因、隐藏令牌并限制长度，正常回收不报错', async () => {
  const errors: string[] = [], order: string[] = []
  const child = spawn(process.execPath, ['-e', 'process.stderr.write("JXA initialization failed http://127.0.0.1/?token=secret-token\\n" + "x".repeat(8000)); process.exitCode=7'], { stdio: ['pipe', 'pipe', 'pipe'] })
  await observeDesktopAssistantProcess(child, (message) => { errors.push(message); order.push('error') }, () => order.push('exit'), () => false)
  assert.deepEqual(order, ['error', 'exit'], '控制器必须先收到具体错误，再收到通用退出通知')
  assert.match(errors[0]!, /JXA initialization failed/u)
  assert.ok(!errors[0]!.includes('secret-token')); assert.ok(errors[0]!.length <= 500)
  const normal = spawn(process.execPath, ['-e', 'process.stderr.write("native cleanup")'], { stdio: ['pipe', 'pipe', 'pipe'] })
  await observeDesktopAssistantProcess(normal, () => assert.fail('正常回收不应报错'), () => {}, () => true)
})

test('原生形象先报告页面就绪，拖动不误打开，点击与键盘走同一事件且字幕转义', (context) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'webkit')
  const events: { type: string }[] = []
  Object.defineProperty(globalThis, 'webkit', { configurable: true, value: { messageHandlers: { assistant: { postMessage: (value: string) => events.push(JSON.parse(value)) } } } })
  const renderer = createHookRenderer(DesktopAssistantAvatar, { frame })
  context.after(() => { renderer.dispose(); if (previous) Object.defineProperty(globalThis, 'webkit', previous); else Reflect.deleteProperty(globalThis, 'webkit') })
  const tree = renderer.render()
  assert.deepEqual(events, [{ type: 'ready' }], '不能等待隐藏页面里的 Live2D 才显示原生窗口')
  const button = elements(tree).find((item) => item.props.role === 'button')!
  const target = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} }
  const pointer = (x: number) => ({ button: 0, isPrimary: true, pointerId: 1, screenX: x, screenY: 30, currentTarget: target, preventDefault() {} })
  button.props.onPointerDown(pointer(10)); button.props.onPointerMove(pointer(30)); button.props.onPointerUp(pointer(30))
  assert.equal(events.filter((event) => event.type === 'open').length, 0)
  button.props.onPointerDown(pointer(10)); button.props.onPointerUp(pointer(10))
  button.props.onKeyDown({ key: 'Enter', preventDefault() {} })
  assert.equal(events.filter((event) => event.type === 'open').length, 2)
  assert.equal(events.filter((event) => event.type === 'drag-start').length, 1)
  const html = renderToStaticMarkup(createElement(DesktopAssistantAvatar, { frame: { ...frame, caption: '<script>恶意内容</script>\n正常字幕' } }))
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>恶意内容'))
})
