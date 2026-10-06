import { spawnSync, type ChildProcessByStdio } from 'node:child_process'
import { dirname } from 'node:path'
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
export function resolveCommandPath(command: string, run: typeof spawnSync = spawnSync): string | null {
  if (isAbsoluteCommand(command)) return command
  try {
    const result = WINDOWS
      ? run('where.exe', [command], { encoding: 'utf8', timeout: 3_000, windowsHide: true })
      : run(process.env.SHELL || '/bin/sh', ['-ilc', 'command -v "$1"; printf "\\n__CODINGNS_PATH__%s\\n" "$PATH"', 'codingns4dsh-command-lookup', command], { encoding: 'utf8', timeout: 3_000, windowsHide: true })
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
  if (!isAbsoluteCommand(command)) return { ...process.env }
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
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
      })
    } catch {
      // taskkill 不可用时继续尝试 Node 的兼容终止路径。
    }
  }
  try { child.kill(signal) } catch { /* 进程可能已经退出 */ }
}
