import { access } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { doubaoBackgroundSocket, DoubaoCdpBridge, type DoubaoBridge } from './doubao-cdp.js'

const exec = promisify(execFile)
export interface DoubaoAppConnection {
  detect(): Promise<{ installed: boolean; version: string | null; command: string | null }>
  connect(launch: boolean, signal?: AbortSignal): Promise<DoubaoBridge>
}

/** 安装发现不启动进程；只有 executeTurn 才能请求按需启动。 */
export class DoubaoApp implements DoubaoAppConnection {
  private launchPromise: Promise<void> | undefined
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly platform = process.platform) {}

  private port(): number {
    const value = this.env.CODINGNS_DOUBAO_CDP_PORT ?? '9225'
    if (!/^\d+$/u.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('CODINGNS_DOUBAO_CDP_PORT 必须是 1024–65535 的端口')
    return Number(value)
  }

  private async appPath(): Promise<string | null> {
    const path = this.env.CODINGNS_DOUBAO_APP_PATH ?? (this.platform === 'darwin' ? '/Applications/Doubao.app' : undefined)
    if (!path) return null
    if (!isAbsolute(path)) throw new Error('CODINGNS_DOUBAO_APP_PATH 必须是绝对路径')
    try { await access(path); return path } catch { return null }
  }

  private async targets(signal?: AbortSignal): Promise<unknown | null> {
    const port = this.port()
    try {
      const timeout = AbortSignal.timeout(1_500)
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' })
      if (!response.ok) throw new Error('豆包调试端口响应异常')
      return await response.json()
    } catch (error) {
      signal?.throwIfAborted()
      // 只有端口未开启可进入启动路径；占用端口的未知服务不能触发第二个进程。
      if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) return null
      throw error
    }
  }

  async detect(): Promise<{ installed: boolean; version: string | null; command: string | null }> {
    this.port()
    const path = await this.appPath()
    if (path && this.platform === 'darwin') {
      const plist = join(path, 'Contents', 'Info.plist')
      const bundle = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { timeout: 3_000 })
      if (bundle.stdout.trim() !== 'com.bot.neotix.doubao') throw new Error('指定路径不是豆包 App')
      const version = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { timeout: 3_000 })
      return { installed: true, version: version.stdout.trim(), command: path }
    }
    const targets = await this.targets()
    if (targets !== null) {
      doubaoBackgroundSocket(targets, this.port())
      return { installed: true, version: null, command: path ?? '豆包 App（本机 CDP）' }
    }
    return { installed: path !== null, version: null, command: path }
  }

  private async launch(): Promise<void> {
    if (this.platform !== 'darwin') throw new Error('当前平台请先手动启动已登录的豆包并开启本机调试端口；Windows 隐藏冷启动尚未验证')
    const path = await this.appPath()
    if (!path) throw new Error('未找到豆包 App，请设置 CODINGNS_DOUBAO_APP_PATH')
    await this.detect()
    const running = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
      'ObjC.import("AppKit"); Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.bot.neotix.doubao").count)'], { timeout: 3_000 })
    if (running.stdout.trim() !== '0') throw new Error('豆包已经运行但未开启调试端口；请自行退出后携调试参数重新启动，适配器不会重启或隐藏当前窗口')
    await exec('/usr/bin/open', ['-g', '-j', '-a', path, '--args', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${this.port()}`], { timeout: 5_000 })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await this.targets() !== null) return
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error('豆包已请求后台启动，但调试端口未就绪；不会自动重启')
  }

  async connect(launch: boolean, signal?: AbortSignal): Promise<DoubaoBridge> {
    signal?.throwIfAborted()
    let targets = await this.targets(signal)
    if (targets === null && launch) {
      this.launchPromise ??= this.launch().finally(() => { this.launchPromise = undefined })
      await this.launchPromise
      signal?.throwIfAborted()
      targets = await this.targets(signal)
    }
    if (targets === null) throw new Error('豆包本机调试端口未开启；只读探测不会启动 App')
    const bridge = await DoubaoCdpBridge.open(doubaoBackgroundSocket(targets, this.port()))
    if (signal?.aborted) { await bridge.close(); signal.throwIfAborted() }
    return bridge
  }
}
