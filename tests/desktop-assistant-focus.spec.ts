import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { buildMacDesktopFocusScript } from '../src/host/desktop-assistant/mac-agent.js'
import { buildWinAssistantScript } from '../src/host/desktop-assistant/win-agent.js'

function fixture() {
  const events: Record<string, unknown>[] = [], calls: unknown[][] = []
  const nil = { isNil: () => true }
  const bundle = { isNil: () => false, path: '/Applications/测试 Desktop.app' }
  const desktop = { isNil: () => false, terminated: false, bundleURL: bundle }
  const options: Record<string, boolean> = {}
  let requestedPid = 0, failure = false
  const configuration = {
    setActivates: (value: boolean) => { options.activates = value },
    setCreatesNewApplicationInstance: (value: boolean) => { options.newInstance = value },
    setAllowsRunningApplicationSubstitution: (value: boolean) => { options.substitute = value },
    setPromptsUserIfNeeded: (value: boolean) => { options.prompt = value },
  }
  const objc = Object.assign((value: unknown) => value, {
    NSRunningApplication: { runningApplicationWithProcessIdentifier: (pid: number) => { requestedPid = pid; return desktop } },
    NSWorkspaceOpenConfiguration: { configuration },
    NSURL: { URLWithString: (value: string) => value },
    NSWorkspace: { sharedWorkspace: { openURLsWithApplicationAtURLConfigurationCompletionHandler: (...args: unknown[]) => {
      if (failure) throw new Error('launch services unavailable')
      calls.push(args)
    } } },
  })
  const context = { $: objc, ObjC: { unwrap: (value: unknown) => value }, parentPid: 4321,
    emit: (event: Record<string, unknown>) => events.push(event), safe: (fn: unknown) => fn }
  const focus = runInNewContext(buildMacDesktopFocusScript() + '\nfocusDesktop', context) as () => void
  const complete = (error: unknown = nil): void => { (calls.at(-1)![3] as Function)(desktop, error) }
  return { focus, complete, context, desktop, bundle, configuration, events, calls, options,
    pid: () => requestedPid, fail: (value: boolean) => { failure = value } }
}

test('macOS 点击把恢复请求交给当前 Desktop 应用，成功交接后才通知页面', () => {
  const f = fixture()
  f.focus(); f.focus()
  assert.equal(f.pid(), 4321)
  assert.equal(f.calls.length, 1, '进行中的点击必须合并，不能打开多个请求')
  assert.deepEqual(Array.from(f.calls[0]![0] as string[]), ['dsh://open'])
  assert.equal(f.calls[0]![1], f.bundle, '应用来源必须是父进程，不能使用协议默认应用')
  assert.equal(f.calls[0]![2], f.configuration)
  assert.deepEqual(f.options, { activates: true, newInstance: false, substitute: false, prompt: false })
  assert.equal(f.events.length, 0, '尚未交接给 Desktop 时不能只打开页面内对话框')
  f.complete()
  assert.equal(f.events[0]?.ev, 'open')
  f.focus(); assert.equal(f.calls.length, 2)
})

test('macOS Desktop 已退出或没有应用包时不启动其他应用', () => {
  for (const configure of [
    (f: ReturnType<typeof fixture>) => { f.context.parentPid = 0 },
    (f: ReturnType<typeof fixture>) => { f.desktop.isNil = () => true },
    (f: ReturnType<typeof fixture>) => { f.desktop.terminated = true },
    (f: ReturnType<typeof fixture>) => { f.bundle.isNil = () => true },
  ]) {
    const f = fixture(); configure(f)
    assert.throws(f.focus, /Desktop application is unavailable/u)
    assert.equal(f.calls.length, 0); assert.equal(f.events.length, 0)
  }
})

test('macOS 唤回失败保留原因，不伪报打开成功，并允许再次请求', () => {
  const f = fixture()
  f.fail(true); assert.throws(f.focus, /launch services unavailable/u)
  f.fail(false); f.focus()
  f.complete({ isNil: () => false, localizedDescription: '应用已退出' })
  assert.equal(f.events[0]?.ev, 'error'); assert.match(String(f.events[0]?.message), /应用已退出/u)
  assert.ok(!f.events.some((event) => event.ev === 'open'))
  f.focus(); assert.equal(f.calls.length, 2)
})

test('Windows 唤回指定父进程的 Desktop，移除 Node 模式并限制前台授权', () => {
  const script = buildWinAssistantScript('C:\\test-sdk')
  assert.match(script, /Process\.GetProcessById\(parentPid\)/u)
  assert.match(script, /new ProcessStartInfo\(desktop\.MainModule\.FileName, "dsh:\/\/open"\)/u)
  assert.match(script, /start\.UseShellExecute = false/u)
  assert.match(script, /start\.EnvironmentVariables\.Remove\("ELECTRON_RUN_AS_NODE"\)/u)
  assert.match(script, /AllowSetForegroundWindow\(\(uint\)parentPid\)/u)
  assert.ok(!script.includes('EnumWindows('), '不能再按标题栏样式猜测主窗口')
  assert.ok(!script.includes('ShowWindowAsync('), '恢复应由 Desktop 壳自身处理')
})
