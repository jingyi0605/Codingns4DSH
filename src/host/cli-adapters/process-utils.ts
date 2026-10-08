import { execFile, spawn, spawnSync, type ChildProcessByStdio, type SpawnSyncOptions, type SpawnSyncReturns } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, join } from 'node:path'
import type { Readable, Writable } from 'node:stream'

/**
 * CodingNS 启动的 CLI 都把 stdout/stderr 接到管道；stdin 是否接管取决于
 * 适配器协议，因此使用可空 stdin 的统一进程句柄，而不是误用
 * ChildProcessWithoutNullStreams。
 */
export type CodingNsChildProcess = ChildProcessByStdio<Writable | null, Readable, Readable>

interface KillableChild {
  readonly pid?: number | undefined
  kill(signal?: number | NodeJS.Signals): boolean
}

/** Windows 的 npm CLI 通常是 .cmd 包装器，必须经由 shell 才能启动。 */
export const WINDOWS = process.platform === 'win32'
let loginShellPath: string | undefined
let loginShellLookup: Promise<void> | undefined
let commandEnvironmentRevision = 0
let runningCommands = 0
const commandQueue: Array<() => void> = []
const commandSignals = new AsyncLocalStorage<AbortSignal>()

/** 探测生命周期向下透传，插件停用时取消运行中及排队中的短命令。 */
export function withCommandSignal<T>(signal: AbortSignal, task: () => T): T {
  return commandSignals.run(signal, task)
}

/** 短命令统一异步执行；旧的同步注入点仅用于不启动进程的测试替身。 */
export async function runAsyncCommand(
  run: typeof spawnSync,
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
  limitConcurrency = true,
): Promise<SpawnSyncReturns<string>> {
  if (run !== spawnSync) return run(command, args, { ...options, encoding: 'utf8' })
  const signal = commandSignals.getStore()
  signal?.throwIfAborted()
  // 安装探测、模型与额度命令共用两条执行通道，避免首轮并发拉起十几个 CLI。
  if (limitConcurrency) await new Promise<void>((resolve) => {
    const enter = (): void => { runningCommands += 1; resolve() }
    if (runningCommands < 2) enter()
    else commandQueue.push(enter)
  })
  const invocation = options.shell === true ? windowsShellInvocation(command, args) : { command, args }
  return new Promise<SpawnSyncReturns<string>>((resolve) => {
    signal?.throwIfAborted()
    const child = execFile(invocation.command, [...invocation.args], {
      encoding: 'utf8',
      timeout: options.timeout ?? 10_000,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      killSignal: 'SIGKILL',
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
    }, (error, stdout, stderr) => {
      resolve({
        pid: child.pid ?? 0,
        status: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        signal: error?.signal ?? null,
        stdout, stderr, output: [null, stdout, stderr],
        ...(error === null ? {} : { error }),
      })
    })
    child.stdin?.end(options.input)
  }).finally(() => { if (limitConcurrency) { runningCommands -= 1; commandQueue.shift()?.() } })
}

/** 手动重新检测时允许重新读取一次登录环境；平时所有 CLI 共享同一次解析。 */
export function invalidateCommandEnvironment(): void {
  commandEnvironmentRevision += 1
  loginShellLookup = undefined
  loginShellPath = undefined
}

/**
 * Windows 的 `.cmd` 入口必须由 cmd.exe 执行，但不能把 argv 直接交给
 * `spawn(..., { shell: true })`：Node 会把数组原样用空格拼接，参数中的空格、
 * 引号和 shell 元字符会在第二次解析时失去边界。这里显式构造唯一的 `/c`
 * 命令字符串，让 Node 只负责传递一个 shell 参数。
 */
export function windowsShellInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec ?? 'cmd.exe',
): { readonly command: string; readonly args: readonly string[] } {
  if (platform !== 'win32') return { command, args }
  const commandLine = [command, ...args].map(quoteCmdArgument).join(' ')
  return { command: comSpec, args: ['/d', '/s', '/c', `"${commandLine}"`] }
}

/** cmd.exe 的普通 argv 引号；配置值自身保留 TOML 引号，不在注入层提前包裹。 */
function quoteCmdArgument(value: string): string {
  if (value === '') return '""'
  if (/^[A-Za-z0-9_./\\:-]+$/u.test(value)) return value
  return `"${value.replace(/"/gu, '""')}"`
}

/**
 * 桌面应用通常不是从登录终端启动，继承到的 PATH 只有系统目录。
 * 先尝试当前进程的 PATH，失败后再从用户登录 Shell 解析命令位置。
 */
export async function resolveCommandPath(command: string, run: typeof spawnSync = spawnSync): Promise<string | null> {
  if (isAbsoluteCommand(command)) return command
  try {
    if (!WINDOWS && run === spawnSync) {
      const revision = commandEnvironmentRevision
      loginShellLookup ??= (async () => {
        const result = await runAsyncCommand(run, process.env.SHELL || '/bin/sh', ['-ilc', 'printf "\\n__CODINGNS_PATH__%s\\n" "$PATH"'], { timeout: 3_000 })
        if (revision !== commandEnvironmentRevision) return
        loginShellPath = result.stdout.match(/(?:^|\n)__CODINGNS_PATH__(.*?)(?:\n|$)/u)?.[1]?.trim() || process.env.PATH || ''
      })()
      await loginShellLookup
      if (revision !== commandEnvironmentRevision) return resolveCommandPath(command, run)
      for (const directory of (loginShellPath ?? '').split(':').filter(Boolean)) {
        const candidate = join(directory, command)
        try { await access(candidate, constants.X_OK); return candidate } catch { /* 继续检查 PATH。 */ }
      }
      return null
    }
    const result = WINDOWS
      ? await runAsyncCommand(run, 'where.exe', [command], { timeout: 3_000 })
      : await runAsyncCommand(run, process.env.SHELL || '/bin/sh', ['-ilc', 'command -v "$1"; printf "\\n__CODINGNS_PATH__%s\\n" "$PATH"', 'codingns4dsh-command-lookup', command], { timeout: 3_000 })
    if (result.status !== 0) return null
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    const pathMarker = output.match(/(?:^|\n)__CODINGNS_PATH__(.*?)(?:\n|$)/u)?.[1]?.trim()
    if (pathMarker) loginShellPath = pathMarker
    const lines = output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    for (const line of lines.reverse()) {
      if (isAbsoluteCommand(line)) return line
    }
  } catch {
    // 登录 Shell 不可用时仍按未安装处理。
  }
  return null
}

/** 把解析出的 CLI 所在目录补到子进程 PATH，确保 npm shim 的 node shebang 可用。 */
export function commandEnvironment(command: string): Record<string, string | undefined> {
  const currentPath = loginShellPath ?? process.env.PATH ?? ''
  if (!isAbsoluteCommand(command)) return { ...process.env, PATH: currentPath }
  const directory = dirname(command)
  const separator = WINDOWS ? ';' : ':'
  const pathEntries = currentPath.split(separator).filter((entry) => entry.length > 0)
  if (!pathEntries.includes(directory)) pathEntries.unshift(directory)
  return { ...process.env, PATH: pathEntries.join(separator) }
}

function isAbsoluteCommand(value: string): boolean {
  return WINDOWS ? /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\') : value.startsWith('/')
}

/**
 * 结束 CLI 进程及其子进程树。
 *
 * Windows 没有 POSIX 进程组信号；仅调用 child.kill() 往往只结束 cmd.exe
 * 包装器，真正的 Node/CLI 子进程仍会占用端口。taskkill /T 是系统自带的
 * 最小进程树清理手段，失败时再回退到 Node 自身的 kill。
 */
export function terminateChildProcess(child: KillableChild, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (WINDOWS && typeof child.pid === 'number' && child.pid > 0) {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3_000, stdio: 'ignore' })
      killer.on('error', () => undefined)
      killer.unref()
    } catch {
      // taskkill 不可用时继续尝试 Node 的兼容终止路径。
    }
  }
  try { child.kill(signal) } catch { /* 进程可能已经退出 */ }
}
