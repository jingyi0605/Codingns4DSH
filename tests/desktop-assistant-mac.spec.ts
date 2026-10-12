import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { buildMacAssistantScript } from '../src/host/desktop-assistant/mac-agent.js'
import { openDesktopAssistantPage } from '../src/host/desktop-assistant/server.js'
import { ASSISTANT_NOTIFICATION_TAIL_CLEARANCE } from '../src/shared/assistant-notifications.js'

const nativeOptions = { skip: process.platform !== 'darwin', timeout: 20000 }
const readyScript = 'window.webkit.messageHandlers.assistant.postMessage(JSON.stringify({type:"ready"}))'

test('macOS 原生布局脚本注入通知尾巴避让常量，避免 JXA 运行时变量缺失', () => {
  const script = buildMacAssistantScript()
  assert.match(script, new RegExp(`var ASSISTANT_NOTIFICATION_TAIL_CLEARANCE=${ASSISTANT_NOTIFICATION_TAIL_CLEARANCE}\\n`))
})

test('macOS 唤回 API 与原生失败回调可用，检查不打开实际应用', nativeOptions, async () => {
  const root = fileURLToPath(new URL('../data/test-runs/', import.meta.url))
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'assistant-focus-'))
  try {
    // 使用自有临时目录中不存在的应用包，只验证原生调用和错误桥接。
    const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `
    ObjC.import('Cocoa')
    $.NSApplication.sharedApplication.setActivationPolicy(2)
    var configuration=$.NSWorkspaceOpenConfiguration.configuration
    var methods=['setActivates:','setCreatesNewApplicationInstance:','setAllowsRunningApplicationSubstitution:','setPromptsUserIfNeeded:']
    methods.forEach(function(name){if(!configuration.respondsToSelector(name))throw new Error(name)})
    if(!$.NSWorkspace.sharedWorkspace.respondsToSelector('openURLs:withApplicationAtURL:configuration:completionHandler:'))throw new Error('missing open API')
    if(!$.NSRunningApplication.currentApplication.respondsToSelector('isTerminated'))throw new Error('missing termination state')
    configuration.setActivates(false);configuration.setCreatesNewApplicationInstance(false)
    configuration.setAllowsRunningApplicationSubstitution(false);configuration.setPromptsUserIfNeeded(false)
    var completed=false,rejected=false,reason=''
    $.NSWorkspace.sharedWorkspace.openURLsWithApplicationAtURLConfigurationCompletionHandler(
      $([$.NSURL.URLWithString('dsh://open')]),$.NSURL.fileURLWithPath(${JSON.stringify(join(directory, 'missing.app'))}),configuration,function(application,error){
        completed=true;rejected=!error.isNil();if(rejected)reason=ObjC.unwrap(error.localizedDescription)
      })
    var deadline=Date.now()+5000
    while(!completed&&Date.now()<deadline)$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.01))
    if(!completed||!rejected||!reason)throw new Error('missing native failure callback')
    'rejected'
  `], { timeout: 10000 })
    assert.equal(stdout.trim(), 'rejected')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('macOS 独立原生进程完成类注册、回环导航和页面就绪回传', nativeOptions, async () => {
  await runMacPage(readyScript)
})

test('macOS 原生导航拒绝不同来源，拒绝后页面与回调仍能工作', nativeOptions, async () => {
  let requests = 0
  const forbidden = createServer((_request, response) => { requests++; response.end('不应访问') })
  await new Promise<void>((resolve) => forbidden.listen(0, '127.0.0.1', resolve))
  const address = forbidden.address(); assert.ok(address && typeof address !== 'string')
  try {
    await runMacPage(`location.assign("http://127.0.0.1:${address.port}/forbidden"); setTimeout(() => { ${readyScript} }, 100)`)
    assert.equal(requests, 0)
  } finally {
    forbidden.closeAllConnections()
    await new Promise<void>((resolve) => forbidden.close(() => resolve()))
  }
})

test('macOS 原生通知回执执行 WebKit 回调后进程仍保持运行', nativeOptions, async () => {
  const events: string[] = []
  await runMacPage(`window.addEventListener('load', () => {
    window.webkit.messageHandlers.assistant.postMessage(JSON.stringify({type:'ready'}))
    setTimeout(() => window.webkit.messageHandlers.assistant.postMessage(JSON.stringify({type:'notice-presented',ownerId:'owner',generation:1,sequence:1,noticeId:'notice',noticeGeneration:1,noticeKind:'completed'})), 100)
  })`, (event, native) => {
    events.push(String(event.ev))
    if (event.ev === 'notice-presented') {
      native.stdin.write(JSON.stringify({ cmd: 'notice-result', accepted: true, message: '' }) + '\n')
      setTimeout(() => native.stdin.end('{"cmd":"quit"}\n'), 100)
    }
  })
  assert.ok(events.includes('notice-presented'))
  assert.ok(!events.includes('error'))
})

test('macOS 原生按伴随页回报的气泡高度收缩通知区，不再保留固定空白区', nativeOptions, async () => {
  const regions: { height: number; limit: number | undefined; bounds: number }[] = []
  let showed = false
  await runMacPage(`window.addEventListener('load', () => {
    window.webkit.messageHandlers.assistant.postMessage(JSON.stringify({type:'ready'}))
    setTimeout(() => window.webkit.messageHandlers.assistant.postMessage(JSON.stringify({type:'notice-size',height:96})), 300)
  })`, (event, native) => {
    const layout = event.layout as { notification?: { height: number; limit?: number }; bounds: { height: number } } | undefined
    if (event.ev === 'layout' && layout?.notification) regions.push({ height: layout.notification.height, limit: layout.notification.limit, bounds: layout.bounds.height })
    if (event.ev === 'loaded' && !showed) {
      showed = true
      native.stdin.write(JSON.stringify({ cmd: 'show', avatarSize: 144, notificationHeight: 276 }) + '\n')
    }
    // 收到收缩后的布局就结束：回传值必须成为通知区高度，而不是只当作额外提示。
    if (event.ev === 'layout' && layout?.notification?.height === 96) native.stdin.end('{"cmd":"quit"}\n')
  })
  const requested = regions.find((region) => region.height === 276)
  const measured = regions.find((region) => region.height === 96)
  assert.ok(requested, `固定请求必须先给出上限区域：${JSON.stringify(regions)}`)
  assert.ok(measured, `实测高度必须收缩通知区：${JSON.stringify(regions)}`)
  assert.ok(measured.limit !== undefined && measured.limit >= measured.height, '布局必须回报气泡可用限高')
  assert.ok(measured.bounds < requested.bounds, '通知区收缩后原生窗口同步变矮')
})

async function runMacPage(bundle: string, onEvent?: (event: Record<string, unknown>, native: ReturnType<typeof spawn>) => void): Promise<void> {
  // 只运行仓库生成的隐藏窗口与空白测试页，不连接或操作已安装 Desktop。
  const root = fileURLToPath(new URL('../data/test-runs/', import.meta.url))
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, 'assistant-mac-'))
  const script = join(directory, 'assistant.js')
  const page = await openDesktopAssistantPage({ frame: () => undefined,
    assets: async () => new Response(null, { status: 404 }),
    readBundle: async () => bundle,
  })
  let stderr = '', stdout = ''
  const events: string[] = []
  let child: ReturnType<typeof spawn> | undefined
  try {
    await writeFile(script, buildMacAssistantScript(), 'utf8')
    const native = spawn('/usr/bin/osascript', ['-l', 'JavaScript', script], { stdio: ['pipe', 'pipe', 'pipe'] })
    child = native
    const exited = new Promise<number | null>((resolve, reject) => { native.once('error', reject); native.once('close', resolve) })
    native.stderr.setEncoding('utf8'); native.stderr.on('data', (chunk: string) => { stderr += chunk })
    native.stdout.setEncoding('utf8'); native.stdout.on('data', (chunk: string) => {
      stdout += chunk
      let newline: number
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const event = JSON.parse(stdout.slice(0, newline)); stdout = stdout.slice(newline + 1)
        events.push(event.ev)
        onEvent?.(event, native)
        if (event.ev === 'error') stderr += event.message
        if (event.ev === 'ready') {
          const command = Buffer.from(JSON.stringify({ cmd: 'load', url: page.url, width: 144, height: 156, userData: '中文目录' }) + '\n')
          // 强制在 UTF-8 字符中间断开，验证 Cocoa 管道不会因中文路径丢掉 load。
          const split = command.indexOf(Buffer.from('中文')) + 1
          native.stdin.write(command.subarray(0, split))
          setTimeout(() => native.stdin.write(command.subarray(split)), 50)
        }
        if (onEvent === undefined && (event.ev === 'loaded' || event.ev === 'error')) native.stdin.end('{"cmd":"quit"}\n')
      }
    })
    const timeout = setTimeout(() => native.kill(), 15000)
    let code: number | null
    try { code = await exited } finally { clearTimeout(timeout) }
    assert.equal(code, 0, `原生初始化失败：${stderr.slice(0, 1500)}`)
    assert.ok(!events.includes('error'), stderr)
    // layout 是原生窗口在加载页面后回传的定位事件，先于页面 ready 的 loaded。
    if (onEvent === undefined) assert.deepEqual(events, ['ready', 'layout', 'loaded'], `原生就绪握手失败：${stderr}`)
    else assert.ok(events.includes('loaded'), `原生就绪握手失败：${stderr}`)
  } finally {
    child?.kill()
    await page.close()
    await rm(directory, { recursive: true, force: true })
  }
}
