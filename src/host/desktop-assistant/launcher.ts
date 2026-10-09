import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { buildMacAssistantScript } from './mac-agent.js'
import { buildWinAssistantScript } from './win-agent.js'
import { observeDesktopAssistantProcess } from './process.js'
import type { DesktopAssistantAgent } from './controller.js'

/** 所有运行数据落在插件自有目录，不触碰 Desktop 壳或其包目录。 */
export function desktopAssistantDirectory(): string { return join(resolveDshHome(), 'codingns4dsh', 'desktop-assistant') }

export async function launchDesktopAssistant(onEvent: (event: Record<string, unknown>) => void, onExit: () => void): Promise<DesktopAssistantAgent> {
  const directory = desktopAssistantDirectory()
  await mkdir(directory, { recursive: true })
  const temporary = await mkdtemp(join(directory, 'run-'))
  const windows = process.platform === 'win32'
  const sdkRoot = fileURLToPath(new URL('../../../../../assets/desktop-assistant/webview2/', import.meta.url))
  const script = join(temporary, windows ? 'assistant.ps1' : 'assistant.js')
  let bounds: unknown
  try { bounds = JSON.parse(await readFile(join(directory, 'position.json'), 'utf8')) } catch { /* 首次运行或损坏记录使用系统默认位置。 */ }
  // PowerShell 5.1 无 BOM 时按系统 ANSI 读取，用户目录含中文会导致 SDK 路径损坏。
  try { await writeFile(script, windows ? '\uFEFF' + buildWinAssistantScript(sdkRoot) : buildMacAssistantScript(), 'utf8') }
  catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
  const command = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/usr/bin/osascript'
  const args = windows ? ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', script] : ['-l', 'JavaScript', script]
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = '', stopped = false, saving = Promise.resolve()
  const failure = (message: string): void => onEvent({ ev: 'error', message })
  const exit = observeDesktopAssistantProcess(child, failure, onExit, () => stopped)
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    if (buffer.length > 65536) { buffer = ''; failure('原生悬浮输出超出限制'); return }
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        if (event.ev === 'moved' && ['x', 'y', 'width', 'height'].every((key) => typeof event[key] === 'number' && Number.isFinite(event[key]))) {
          const value = JSON.stringify({ x: event.x, y: event.y, width: event.width, height: event.height,
            ...(typeof event.avatarX === 'number' && Number.isFinite(event.avatarX) ? { avatarX: event.avatarX } : {}),
            ...(typeof event.avatarY === 'number' && Number.isFinite(event.avatarY) ? { avatarY: event.avatarY } : {}) })
          // 只保存完成拖动的位置；串行原子替换，退出等待最后一笔。
          saving = saving.then(async () => { await writeFile(join(temporary, 'position.json'), value); await rename(join(temporary, 'position.json'), join(directory, 'position.json')) }).catch(() => undefined)
        }
        onEvent(event)
      } catch { /* 非协议行不解释为命令。 */ }
    }
  })
  return {
    send(command) {
      if (stopped || child.stdin.destroyed) return
      const extra = command.cmd === 'load' ? { parentPid: process.ppid, userData: join(directory, 'webview2'), bounds } : {}
      child.stdin.write(JSON.stringify({ ...command, ...extra }) + '\n')
    },
    async stop() {
      if (stopped) { await exit; return }
      stopped = true
      if (!child.stdin.destroyed) child.stdin.end(JSON.stringify({ cmd: 'quit' }) + '\n')
      const timer = setTimeout(() => child.kill(), 2000)
      await exit; clearTimeout(timer)
      await saving
      await rm(temporary, { recursive: true, force: true })
    },
  }
}
