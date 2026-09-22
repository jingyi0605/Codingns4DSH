import { spawn } from 'node:child_process'

const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const children = [
  spawn(packageManager, ['exec', 'tsc', '--watch', '--preserveWatchOutput'], { stdio: 'inherit' }),
  spawn(packageManager, ['exec', 'tsdown', '--watch'], { stdio: 'inherit' }),
]

let stopping = false

function stop(code) {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGINT')
  process.exitCode = code
}

for (const child of children) {
  child.once('error', (error) => {
    console.error(`开发监听进程启动失败: ${error.message}`)
    stop(1)
  })
  child.once('exit', (code, signal) => {
    if (stopping) return
    const status = signal === null ? `退出码 ${code ?? 1}` : `信号 ${signal}`
    console.error(`开发监听进程意外结束（${status}）`)
    stop(code === 0 ? 1 : (code ?? 1))
  })
}

process.once('SIGINT', () => stop(0))
process.once('SIGTERM', () => stop(0))
