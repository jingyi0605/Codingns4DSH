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
