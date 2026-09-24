import { accessSync, constants } from 'node:fs'

export type TerminalShellProfileId = 'system' | 'zsh' | 'bash' | 'powershell' | 'cmd' | 'git-bash'

export interface DetectedTerminalShell {
  readonly profileId: Exclude<TerminalShellProfileId, 'system'>
  readonly displayName: string
  readonly path: string | null
  readonly available: boolean
  readonly unavailableReason?: string
}

export interface ShellDetectionOptions {
  readonly platform?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly isExecutable?: (path: string) => boolean
}

export interface ResolvedTerminalShell {
  readonly requestedProfileId: TerminalShellProfileId
  readonly resolvedProfileId: Exclude<TerminalShellProfileId, 'system'>
  readonly path: string
  readonly fallbackReason?: string
}

/** 平台探测只返回白名单 profile，浏览器不能借此提交任意可执行文件。 */
export function detectTerminalShells(options: ShellDetectionOptions = {}): readonly DetectedTerminalShell[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const executable = options.isExecutable ?? defaultIsExecutable
  if (platform === 'win32') return detectWindowsShells(env, executable)
  if (platform === 'darwin' || platform === 'linux') return detectPosixShells(platform, env, executable)
  return []
}

export function resolveTerminalShell(
  requestedProfileId: TerminalShellProfileId,
  detected: readonly DetectedTerminalShell[],
  platform: string = process.platform,
): ResolvedTerminalShell {
  const requested = requestedProfileId === 'system'
    ? undefined
    : detected.find((shell) => shell.profileId === requestedProfileId)
  if (requested?.available && requested.path !== null) {
    return { requestedProfileId, resolvedProfileId: requested.profileId, path: requested.path }
  }

  const order: readonly Exclude<TerminalShellProfileId, 'system'>[] = platform === 'win32'
    ? ['powershell', 'cmd']
    : ['zsh', 'bash']
  const fallback = order
    .map((profileId) => detected.find((shell) => shell.profileId === profileId))
    .find((shell): shell is DetectedTerminalShell & { path: string } => shell?.available === true && shell.path !== null)
  if (fallback === undefined) throw new Error('当前平台没有可用的受支持终端 shell')
  return {
    requestedProfileId,
    resolvedProfileId: fallback.profileId,
    path: fallback.path,
    ...(requestedProfileId === 'system'
      ? {}
      : { fallbackReason: `${requestedProfileId} 当前不可用，已回退到${fallback.displayName}` }),
  }
}

function detectPosixShells(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
  executable: (path: string) => boolean,
): readonly DetectedTerminalShell[] {
  const envShell = env.SHELL
  const zsh = firstExecutable([
    ...(envShell?.endsWith('/zsh') ? [envShell] : []),
    '/bin/zsh',
    '/usr/bin/zsh',
    ...(platform === 'darwin' ? ['/opt/homebrew/bin/zsh', '/usr/local/bin/zsh'] : []),
  ], executable, platform)
  const bash = firstExecutable([
    ...(envShell?.endsWith('/bash') ? [envShell] : []),
    '/bin/bash',
    '/usr/bin/bash',
    '/usr/local/bin/bash',
  ], executable, platform)
  return [shellResult('zsh', 'zsh', zsh), shellResult('bash', 'bash', bash)]
}

function detectWindowsShells(
  env: Readonly<Record<string, string | undefined>>,
  executable: (path: string) => boolean,
): readonly DetectedTerminalShell[] {
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows'
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const localAppData = env.LOCALAPPDATA
  const powershell = firstExecutable([
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    `${programFiles}\\PowerShell\\7\\pwsh.exe`,
  ], executable, 'win32')
  const cmd = firstExecutable([env.ComSpec ?? '', `${systemRoot}\\System32\\cmd.exe`], executable, 'win32')
  const gitBash = firstExecutable([
    `${programFiles}\\Git\\bin\\bash.exe`,
    ...(localAppData ? [`${localAppData}\\Programs\\Git\\bin\\bash.exe`] : []),
  ], executable, 'win32')
  return [
    shellResult('powershell', 'PowerShell', powershell),
    shellResult('cmd', '命令提示符', cmd),
    shellResult('git-bash', 'Git Bash', gitBash),
  ]
}

function firstExecutable(paths: readonly string[], executable: (path: string) => boolean, platform: string): string | null {
  return paths.find((path) => path !== '' && isAbsoluteForPlatform(path, platform) && executable(path)) ?? null
}

function isAbsoluteForPlatform(path: string, platform: string): boolean {
  return platform === 'win32' ? /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') : path.startsWith('/')
}

function shellResult(
  profileId: Exclude<TerminalShellProfileId, 'system'>,
  displayName: string,
  path: string | null,
): DetectedTerminalShell {
  return path === null
    ? { profileId, displayName, path: null, available: false, unavailableReason: '未找到可执行文件' }
    : { profileId, displayName, path, available: true }
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
