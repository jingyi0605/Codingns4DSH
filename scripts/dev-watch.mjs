import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Stage0 通过 IPC 等待首次成功编译，避免载入旧产物或尚未生成的入口。
const managed = typeof process.send === 'function'
const options = {
  cwd: repositoryRoot,
  stdio: managed ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  detached: process.platform !== 'win32',
}

// Windows .cmd launchers must run through the command shell.
function spawnCompiler(args) {
  return process.platform === 'win32'
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `${packageManager} ${args.join(' ')}`], options)
    : spawn(packageManager, args, options)
}

const children = [
  spawnCompiler(['exec', 'tsc', '--watch', '--preserveWatchOutput', '--pretty', 'false', '--locale', 'en']),
  spawnCompiler(['exec', 'tsdown', '--watch']),
]

let stopping = false
const ready = new Set()

if (managed) {
  for (const [index, child] of children.entries()) {
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      process.stdout.write(`${line}\n`)
      const plain = line.replace(/\u001b\[[0-9;]*m/gu, '')
      const success = index === 0
        ? /Found 0 errors\. Watching for file changes\./u.test(plain)
        : /Build complete|Rebuilt in/u.test(plain)
      if (!success || ready.has(index)) return
      ready.add(index)
      if (ready.size === children.length && !stopping) process.send?.({ type: 'watch-ready' })
    })
  }
}

function signalChild(child, signal) {
  if (child.pid === undefined) return
  try {
    // pnpm 会再派生编译器；只杀 pnpm 本身会留下仍在写产物的孤儿进程。
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

function stop(code) {
  if (stopping) return
  stopping = true
  for (const child of children) signalChild(child, 'SIGTERM')
  setTimeout(() => {
    for (const child of children) signalChild(child, 'SIGKILL')
  }, 5000).unref()
  if (process.connected) process.disconnect()
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
if (managed) process.once('disconnect', () => stop(0))
