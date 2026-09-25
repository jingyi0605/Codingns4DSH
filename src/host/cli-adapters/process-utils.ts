import { spawnSync } from 'node:child_process'

interface KillableChild {
  readonly pid?: number | null
  kill(signal?: string): boolean
}

/** Windows 的 npm CLI 通常是 .cmd 包装器，必须经由 shell 才能启动。 */
export const WINDOWS = process.platform === 'win32'

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
