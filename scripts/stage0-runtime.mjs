import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.CODINGNS4DSH_STAGE0_REPO_URL = new URL('../', import.meta.url).href
const [launcher, ...args] = process.argv.slice(2)
const children = new Set()
let stopping = false
let started = false
let startupTimer
let shutdownTimer

/** 只操作本次启动的进程组，不扫描或结束其他 Stage0、Desktop、watch 进程。 */
function signalChild(child, signal) {
  if (child.pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function stop(code) {
  if (stopping) return
  stopping = true
  clearTimeout(startupTimer)
  process.exitCode = code
  for (const child of children) signalChild(child, 'SIGTERM')
  shutdownTimer = setTimeout(() => {
    for (const child of children) signalChild(child, 'SIGKILL')
  }, 6000)
  shutdownTimer.unref()
}

function track(child, role) {
  children.add(child)
  child.once('error', (error) => {
    console.error(`dsh-stage0: ${role} 启动失败：${error.message}`)
    children.delete(child)
    stop(1)
  })
  child.once('exit', (code, signal) => {
    // 入口退出后仍可能有派生进程存活，先回收本次拥有的进程组。
    signalChild(child, 'SIGTERM')
    children.delete(child)
    if (!stopping) {
      if (role === '编译监听') {
        console.error(`dsh-stage0: 编译监听意外退出：${signal ?? code}`)
        stop(code === 0 ? 1 : (code ?? 1))
      } else {
        stop(code ?? (signal === 'SIGINT' ? 130 : 143))
      }
    }
    if (children.size === 0) clearTimeout(shutdownTimer)
  })
  return child
}

function startDsh() {
  if (stopping || started) return
  started = true
  clearTimeout(startupTimer)
  track(spawn(process.execPath, [launcher, ...args], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
  }), 'DSH')
}

process.once('SIGINT', () => stop(130))
process.once('SIGTERM', () => stop(143))

if (process.env.CODINGNS4DSH_STAGE0_WATCH === '1') {
  console.error('dsh-stage0: 启动 dev:watch，等待 Host 和 Client 首次编译成功。')
  const watcher = track(spawn(process.execPath, [join(repositoryRoot, 'scripts/dev-watch.mjs')], {
    cwd: repositoryRoot,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    detached: process.platform !== 'win32',
  }), '编译监听')
  watcher.on('message', (message) => {
    if (message?.type !== 'watch-ready') return
    console.error('dsh-stage0: 首次编译成功，启动 DSH 并启用自动重载。')
    startDsh()
  })
  startupTimer = setTimeout(() => {
    console.error('dsh-stage0: 90 秒内未完成首次编译，请检查上方编译错误。')
    stop(1)
  }, 90_000)
} else {
  startDsh()
}
