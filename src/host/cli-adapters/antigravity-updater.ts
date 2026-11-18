import { spawn, type SpawnOptions } from 'node:child_process'
import { isWindowsBatchCommand, terminateChildProcess, windowsShellInvocation, type CodingNsChildProcess } from './process-utils.js'

export function spawnAntigravity(runSpawn: typeof spawn, command: string, args: readonly string[], options: SpawnOptions): CodingNsChildProcess {
  const batch = isWindowsBatchCommand(command)
  const invocation = batch ? windowsShellInvocation(command, args) : { command, args }
  return runSpawn(invocation.command, invocation.args, { ...options, shell: false, windowsVerbatimArguments: batch }) as CodingNsChildProcess
}

/** Windows 的 detached updater 会在探测版本时创建可见终端；其它平台保留原生更新。 */
export function antigravityCommandEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: string = process.platform,
): NodeJS.ProcessEnv {
  return platform === 'win32' ? { ...environment, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } : environment
}

/** 用 agy 官方前台更新入口代替 Windows 上存在闪窗缺陷的 detached updater。 */
export class AntigravityAutoUpdater {
  private child: ReturnType<typeof spawn> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastCommand: string | null = null
  private nextCheck = 0
  private disposed = false

  constructor(
    private readonly runSpawn: typeof spawn = spawn,
    private readonly now: () => number = Date.now,
    private readonly platform: string = process.platform,
  ) {}

  check(command: string, environment: NodeJS.ProcessEnv): void {
    if (this.disposed || this.platform !== 'win32' || this.child !== null
      || environment.AGY_CLI_DISABLE_AUTO_UPDATE === 'true') return
    const now = this.now()
    if (command === this.lastCommand && now < this.nextCheck) return
    // 和 agy 原生更新一样，使用时最多每 15 分钟检查一次，失败也不密集重试。
    this.lastCommand = command
    this.nextCheck = now + 15 * 60_000
    let child: ReturnType<typeof spawn>
    try {
      child = spawnAntigravity(this.runSpawn, command, ['update'], {
        env: antigravityCommandEnvironment(environment, 'win32'),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      return
    }
    this.child = child
    const finish = (): void => {
      if (this.child !== child) return
      this.child = null
      clearTimeout(this.timer)
      this.timer = undefined
    }
    // 更新输出不进入会话、Client 或日志；消费管道，避免下载进度阻塞进程。
    child.stdout?.on('error', () => undefined)
    child.stderr?.on('error', () => undefined)
    child.stdout?.resume()
    child.stderr?.resume()
    child.once('error', finish)
    child.once('close', finish)
    this.timer = setTimeout(() => {
      finish()
      terminateChildProcess(child)
    }, 5 * 60_000)
    this.timer.unref()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.timer = undefined
    const child = this.child
    this.child = null
    if (child !== null) terminateChildProcess(child)
  }
}
