import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { win32 } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { commandEnvironment, resolveCommandPath, terminateChildProcess, windowsShellInvocation, WINDOWS } from './process-utils.js'
import type { ManagementCommand } from './management-methods.js'
import { runZcodeUpdate } from './zcode-update.js'

export type ManagementRunner = (command: ManagementCommand, signal: AbortSignal, onOutput: (text: string) => void) => Promise<number | null>

/** Run a fixed publisher command without an interactive shell or privilege escalation. */
export const runManagementCommand: ManagementRunner = async (command, signal, onOutput) => {
  signal.throwIfAborted()
  if (command.zcodeUpdate) return runZcodeUpdate(command, signal, onOutput, runManagementCommand)
  const file = await resolveCommandPath(command.file)
  if (file === null) throw new Error(`Required command is unavailable: ${command.file}. Install the prerequisite and try again.`)
  signal.throwIfAborted()
  const nsisDirectory = command.nsisInstallDirectory
  if (nsisDirectory !== undefined && (!WINDOWS || !/\.exe$/iu.test(file) || !win32.isAbsolute(nsisDirectory) || /["\r\n]/u.test(file + nsisDirectory))) {
    throw new Error('NSIS updates require an executable installer and an absolute Windows installation directory without quotes or line breaks.')
  }
  const args = nsisDirectory === undefined ? command.args : [...command.args, `/D=${nsisDirectory}`]
  const batch = WINDOWS && /\.(?:cmd|bat)$/iu.test(file)
  const invocation = batch ? windowsShellInvocation(file, args) : { command: file, args }
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: homedir(), env: { ...commandEnvironment(file), NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      detached: !WINDOWS, ...(batch || nsisDirectory !== undefined ? { windowsVerbatimArguments: true } : {}),
      // NSIS reads the raw command line: quote argv[0], but leave the final /D= path unquoted.
      ...(nsisDirectory === undefined ? {} : { argv0: `"${file}"` }),
    })
    const stop = (): void => {
      if (!WINDOWS && child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* Fall back if the process group has already exited. */ }
      }
      terminateChildProcess(child, 'SIGKILL')
    }
    const output = (chunk: string): void => onOutput(chunk)
    child.stdout.setEncoding('utf8').on('data', output)
    child.stderr.setEncoding('utf8').on('data', output)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    child.once('error', reject)
    child.once('close', (code) => {
      signal.removeEventListener('abort', stop)
      resolve(code)
    })
  })
}

/** Apply redaction to the whole bounded buffer so chunk boundaries cannot split a secret. */
export function managementOutput(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/((?:authorization|token|api[_-]?key|password)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/giu, '$1[redacted]')
    .replace(/\b(?:sk|ghp|gho|npm)_[A-Za-z0-9_-]{12,}\b|\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[redacted]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '')
}
