import { access } from 'node:fs/promises'
import { isAbsolute, join, win32 } from 'node:path'
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { doubaoBackgroundSocket, DoubaoCdpBridge, type DoubaoBridge } from './doubao-cdp.js'
import type { CodingNsCliDetection } from '../../shared/contracts/cli-adapter.js'

const execFileAsync = promisify(execFile)
type DoubaoExec = (file: string, args: string[], options?: { readonly timeout?: number; readonly windowsHide?: boolean }) => Promise<{ readonly stdout: string; readonly stderr: string }>
type DoubaoSpawn = (file: string, args: string[], options: SpawnOptions) => ChildProcess

/** 仅用于隔离平台启动测试；生产环境使用 Node 原生文件、命令和进程实现。 */
export interface DoubaoAppRuntime {
  readonly access?: typeof access
  readonly exec?: DoubaoExec
  readonly spawn?: DoubaoSpawn
  readonly fetch?: typeof fetch
  readonly sleep?: (milliseconds: number) => Promise<void>
}

const defaultRuntime: Required<DoubaoAppRuntime> = {
  access,
  exec: async (file, args, options) => {
    const result = await execFileAsync(file, args, { ...options, encoding: 'utf8' })
    return { stdout: String(result.stdout), stderr: String(result.stderr) }
  },
  spawn,
  fetch,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

export interface DoubaoAppConnection {
  detect(): Promise<CodingNsCliDetection>
  connect(launch: boolean, signal?: AbortSignal): Promise<DoubaoBridge>
}

/** 安装发现不启动进程；只有 executeTurn 才能请求按需启动。 */
export class DoubaoApp implements DoubaoAppConnection {
  private launchPromise: Promise<void> | undefined
  private readonly runtime: Required<DoubaoAppRuntime>
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly platform = process.platform, runtime: DoubaoAppRuntime = {}) {
    this.runtime = { ...defaultRuntime, ...runtime }
  }

  private port(): number {
    const value = this.env.CODINGNS_DOUBAO_CDP_PORT ?? '9225'
    if (!/^\d+$/u.test(value) || Number(value) < 1024 || Number(value) > 65535) throw new Error('CODINGNS_DOUBAO_CDP_PORT 必须是 1024–65535 的端口')
    return Number(value)
  }

  private async appPath(): Promise<string | null> {
    const path = this.env.CODINGNS_DOUBAO_APP_PATH ?? (this.platform === 'darwin' ? '/Applications/Doubao.app' : undefined)
    if (!path) return null
    if (!this.isAbsolute(path)) throw new Error('CODINGNS_DOUBAO_APP_PATH 必须是绝对路径')
    if (this.platform === 'win32') return this.resolveWindowsPath(path)
    try { await this.runtime.access(path); return path } catch { return null }
  }

  private isAbsolute(path: string): boolean {
    return this.platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path)
  }

  private async pathExists(path: string): Promise<boolean> {
    try { await this.runtime.access(path); return true } catch { return false }
  }

  /** Windows 安装位置没有统一约定，先尊重显式路径，再查常见目录、App Paths 和 PATH。 */
  private async resolveWindowsPath(path: string): Promise<string | null> {
    const configured = win32.extname(path).toLowerCase() === '.exe' ? [path] : [win32.join(path, 'Doubao.exe')]
    for (const candidate of configured) if (await this.pathExists(candidate)) return candidate
    return null
  }

  private async windowsAppPath(): Promise<string | null> {
    const roots = [this.env.LOCALAPPDATA, this.env.ProgramFiles, this.env['ProgramFiles(x86)'], this.env.USERPROFILE]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    const relativePaths = [
      ['Doubao', 'Doubao.exe'],
      ['ByteDance', 'Doubao', 'Doubao.exe'],
      ['Doubao App', 'Doubao.exe'],
      ['ByteDance', 'Doubao App', 'Doubao.exe'],
      ['Programs', 'Doubao', 'Doubao.exe'],
    ]
    for (const root of [...new Set(roots)]) {
      for (const parts of relativePaths) {
        const candidate = win32.join(root, ...parts)
        if (await this.pathExists(candidate)) return candidate
      }
    }
    const registryKeys = [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Doubao.exe',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Doubao.exe',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Doubao.exe',
    ]
    const systemRoot = this.env.SystemRoot ?? this.env.SYSTEMROOT ?? 'C:\\Windows'
    const systemBinary = (name: string): string => win32.join(systemRoot, 'System32', name)
    for (const key of registryKeys) {
      try {
        const result = await this.runtime.exec(systemBinary('reg.exe'), ['query', key, '/ve'], { timeout: 3_000, windowsHide: true })
        const value = result.stdout.match(/REG_SZ\s+(.+)\s*$/imu)?.[1]?.trim().replace(/^"|"$/gu, '')
        if (value !== undefined && await this.pathExists(value)) return value
      } catch { /* 注册表不可读时继续检查 PATH。 */ }
    }
    const uninstallRoots = [
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ]
    for (const root of uninstallRoots) {
      try {
        const result = await this.runtime.exec(systemBinary('reg.exe'), ['query', root, '/s'], { timeout: 3_000, windowsHide: true })
        for (const value of registryInstallValues(result.stdout)) {
          const executable = value.toLowerCase().endsWith('.exe') ? value : win32.join(value, 'Doubao.exe')
          if (await this.pathExists(executable)) return executable
        }
      } catch { /* 卸载注册表不可读时继续检查 PATH。 */ }
    }
    try {
      const result = await this.runtime.exec(systemBinary('where.exe'), ['Doubao.exe'], { timeout: 3_000, windowsHide: true })
      for (const value of result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)) {
        if (win32.isAbsolute(value) && await this.pathExists(value)) return value
      }
    } catch { /* PATH 中没有豆包时按未发现处理。 */ }
    return null
  }

  private async targets(signal?: AbortSignal): Promise<unknown | null> {
    const port = this.port()
    try {
      const timeout = AbortSignal.timeout(1_500)
      const response = await this.runtime.fetch(`http://127.0.0.1:${port}/json/list`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' })
      if (!response.ok) throw new Error('豆包调试端口响应异常')
      return await response.json()
    } catch (error) {
      signal?.throwIfAborted()
      // 只有端口未开启可进入启动路径；占用端口的未知服务不能触发第二个进程。
      if (error instanceof TypeError || (error instanceof Error && error.name === 'TimeoutError')) return null
      throw error
    }
  }

  async detect(): Promise<CodingNsCliDetection> {
    this.port()
    const path = await this.appPath()
    let version: string | null = null
    if (path && this.platform === 'darwin') {
      const plist = join(path, 'Contents', 'Info.plist')
      const bundle = await this.runtime.exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { timeout: 3_000 })
      if (bundle.stdout.trim() !== 'com.bot.neotix.doubao') throw new Error('指定路径不是豆包 App')
      const versionResult = await this.runtime.exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { timeout: 3_000 })
      version = versionResult.stdout.trim()
    }
    const targets = await this.targets()
    if (targets !== null) {
      doubaoBackgroundSocket(targets, this.port())
      return { installed: true, runtimeState: 'ready', version, command: path ?? '豆包 App（本机 CDP）' }
    }
    const installedPath = path ?? (this.platform === 'win32' ? await this.windowsAppPath() : null)
    return {
      installed: installedPath !== null,
      runtimeState: installedPath === null ? 'missing' : 'installed',
      version,
      command: installedPath,
    }
  }

  private async waitForTargets(): Promise<void> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await this.targets() !== null) return
      await this.runtime.sleep(300)
    }
    throw new Error('豆包已请求后台启动，但调试端口未就绪；不会自动重启')
  }

  private async windowsProcessRunning(path: string): Promise<boolean> {
    const image = win32.basename(path) || 'Doubao.exe'
    try {
      const root = this.env.SystemRoot ?? this.env.SYSTEMROOT ?? 'C:\\Windows'
      const result = await this.runtime.exec(win32.join(root, 'System32', 'tasklist.exe'), ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { timeout: 3_000, windowsHide: true })
      return result.stdout.split(/\r?\n/u).some((line) => line.match(/^"([^"]+)"/u)?.[1]?.toLowerCase() === image.toLowerCase())
    } catch { return false }
  }

  private async spawnWindows(path: string): Promise<void> {
    const child = this.runtime.spawn(path, ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${this.port()}`], {
      detached: true, windowsHide: true, stdio: 'ignore',
    })
    await new Promise<void>((resolve, reject) => {
      const spawned = (): void => { cleanup(); resolve() }
      const failed = (error: Error): void => { cleanup(); reject(new Error(`无法启动豆包 App：${error.message}`)) }
      const cleanup = (): void => { child.removeListener('spawn', spawned); child.removeListener('error', failed) }
      child.once('spawn', spawned)
      child.once('error', failed)
    })
    child.unref()
  }

  private async launch(): Promise<void> {
    const path = await this.appPath() ?? (this.platform === 'win32' ? await this.windowsAppPath() : null)
    if (!path) throw new Error('未找到豆包 App，请设置 CODINGNS_DOUBAO_APP_PATH')
    if (this.platform === 'win32') {
      if (await this.windowsProcessRunning(path)) throw new Error('豆包已经运行但未开启调试端口；请完全退出后再由 CodingNS 按需启动')
      await this.spawnWindows(path)
      await this.waitForTargets()
      return
    }
    if (this.platform !== 'darwin') throw new Error('当前平台不支持自动启动豆包；请手动启动并开启本机调试端口')
    await this.detect()
    const running = await this.runtime.exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
      'ObjC.import("AppKit"); Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.bot.neotix.doubao").count)'], { timeout: 3_000 })
    if (running.stdout.trim() !== '0') throw new Error('豆包已经运行但未开启调试端口；请自行退出后携调试参数重新启动，适配器不会重启或隐藏当前窗口')
    await this.runtime.exec('/usr/bin/open', ['-g', '-j', '-a', path, '--args', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${this.port()}`], { timeout: 5_000 })
    await this.waitForTargets()
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

/** 从 Windows 卸载项读取安装入口；DisplayIcon 常带有 `,0` 图标索引后缀。 */
function registryInstallValues(output: string): readonly string[] {
  const values: string[] = []
  let key = ''
  let displayName = ''
  let entryValues: string[] = []
  const flush = (): void => {
    if (/doubao/iu.test(key) || /doubao/iu.test(displayName) || entryValues.some((value) => /doubao/iu.test(value))) values.push(...entryValues)
    displayName = ''
    entryValues = []
  }
  for (const line of output.split(/\r?\n/u)) {
    const keyMatch = line.match(/^(HKEY_[^\r\n]+)$/iu)
    if (keyMatch) {
      flush()
      key = keyMatch[1]!.trim()
      continue
    }
    const nameMatch = line.match(/^\s*DisplayName\s+REG_\w+\s+(.+?)\s*$/iu)
    if (nameMatch) {
      displayName = nameMatch[1]!.trim().replace(/^"|"$/gu, '')
      continue
    }
    const valueMatch = line.match(/^\s*(?:DisplayIcon|InstallLocation)\s+REG_\w+\s+(.+?)\s*$/iu)
    if (!valueMatch) continue
    const value = valueMatch[1]!.trim()
      .replace(/^"(.*)"(?:,\d+)?$/u, '$1')
      .replace(/,\d+$/u, '')
      .trim()
    if (value !== '') entryValues.push(value)
  }
  flush()
  return values
}
