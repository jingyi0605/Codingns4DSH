import { access, constants, readdir, stat } from 'node:fs/promises'
import { win32, join } from 'node:path'
import type {
  MagpieDetectionFailure,
  MagpieDetectionRequest,
  MagpieHostPlatform,
  MagpieInstallDetection,
  MagpieInstallSource,
} from '../../shared/contracts/magpie-management.js'
import { commandEnvironment, invalidateCommandEnvironment, resolveCommandPath, resolvedCommandPathEntries, runAsyncCommand, WINDOWS, windowsShellInvocation } from './process-utils.js'
import { spawnSync } from 'node:child_process'

const MAGPIE_COMMAND = 'magpie'
const DETECTION_TIMEOUT_MS = 5_000
const MAX_VERSION_OUTPUT_BYTES = 256
/** 设置页每次渲染都可能读取探测结果；已安装结果短期复用，避免反复拉起 CLI 进程。 */
const MAX_DETECTION_CACHE_MS = 30_000
/** 本机 PATH 里的可执行入口；Windows 上 npm 生成的无扩展名 POSIX shim 不执行。 */
const EXECUTABLE_ENTRY = /\.(?:exe|com|cmd|bat)$/iu
/** 官方 GitHub 构建与安装脚本可能保留发布文件名，也可能改名为 magpie.exe。 */
const WINDOWS_LAUNCHER_NAMES = [
  'magpie.exe',
  'magpie.cmd',
  'magpie.bat',
  'magpie-windows-amd64.exe',
  'magpie-windows-arm64.exe',
  'magpie-cli-windows-amd64.exe',
  'magpie-cli-windows-arm64.exe',
] as const
/** macOS/Linux 包管理器与手动安装的常见目录；只在 PATH 未命中时补充探测。 */
const POSIX_COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'] as const

export interface MagpieCliRunResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export interface MagpieDetectionServiceOptions {
  /** `process.platform`；测试注入其他平台时走对应分支，不读取宿主平台。 */
  readonly platform?: NodeJS.Platform
  readonly environment?: NodeJS.ProcessEnv
  /** 与 CLI 探测共用的命令解析；测试可替换为不接受真实登录 Shell 的替身。 */
  readonly resolvePath?: (command: string, platform: NodeJS.Platform) => Promise<string | null>
  /** 运行 `magpie --version`；返回 null 表示入口不存在或无法启动。 */
  readonly runVersion?: (command: string, platform: NodeJS.Platform) => Promise<MagpieCliRunResult | null>
  /** 登录 Shell 解析出的 PATH 文本；缺省读取进程共享的已解析结果，测试可固定为空。 */
  readonly pathEntries?: () => string
  /** 用户在本会话里手动指定的入口；指定后只探测该入口，不再自动查找。 */
  readonly customCommand?: string
  /** 只用于“包装脚本 + 同目录 exe”这类常见布局的目录枚举，测试可替换。 */
  readonly listDirectory?: (directory: string) => Promise<readonly string[]>
  /** 文件可执行判断；Windows 只判断存在性，POSIX 还要求可执行。 */
  readonly isExecutable?: (path: string, platform: NodeJS.Platform) => Promise<boolean>
  readonly now?: () => number
}

/**
 * 本机 Magpie 安装探测。
 *
 * 两条平台路径刻意分开：
 * - macOS/Linux：登录 Shell 的完整 PATH（覆盖 Homebrew、nvm、fnm、volta 等用户目录），
 *   再用常见 bin 目录兜底；入口必须是可执行文件。
 * - Windows：`where.exe` 命中的 `.exe/.cmd/.bat` 优先（同时覆盖注册表 PATH），
 *   再扫描 PATH 目录与 USERPROFILE / APPDATA / LOCALAPPDATA 下的 standalone、npm、
 *   pnpm、Bun、Volta 全局目录。无扩展名 shim 不执行。
 */
export class MagpieInstallDetectionService {
  private readonly platform: NodeJS.Platform
  private readonly environment: NodeJS.ProcessEnv
  private readonly resolvePath: (command: string, platform: NodeJS.Platform) => Promise<string | null>
  private readonly runVersion: (command: string, platform: NodeJS.Platform) => Promise<MagpieCliRunResult | null>
  private readonly listDirectory: (directory: string) => Promise<readonly string[]>
  private readonly isExecutable: (path: string, platform: NodeJS.Platform) => Promise<boolean>
  private readonly now: () => number
  private readonly pathEntries: () => string
  private readonly customCommand: string | null
  /** 上次结果；只缓存“已安装”，未安装必须每次重新探测，否则装完还要等缓存过期。 */
  private cached: { readonly key: string; readonly detection: MagpieInstallDetection; readonly readAt: number } | null = null

  constructor(options: MagpieDetectionServiceOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.environment = options.environment ?? process.env
    this.resolvePath = options.resolvePath ?? ((command, platform) => resolveCommandPathForPlatform(command, platform))
    this.runVersion = options.runVersion ?? ((command, platform) => runMagpieVersion(command, platform))
    this.listDirectory = options.listDirectory ?? defaultListDirectory
    this.isExecutable = options.isExecutable ?? defaultIsExecutable
    this.now = options.now ?? Date.now
    this.pathEntries = options.pathEntries ?? resolvedCommandPathEntries
    this.customCommand = normalizeCustomCommand(options.customCommand)
  }

  /** 探测本机 Magpie；`force` 表示用户点了“重新检测”，跳过短期缓存。 */
  async detect(request: MagpieDetectionRequest = {}, options: { readonly force?: boolean } = {}): Promise<MagpieInstallDetection> {
    const custom = normalizeCustomCommand(request.commandPath) ?? this.customCommand
    const key = custom ?? ''
    const cached = this.cached
    if (cached !== null && cached.key === key && options.force !== true
      && (custom !== null || this.now() - cached.readAt < MAX_DETECTION_CACHE_MS)) {
      return cached.detection
    }
    // 手动重新检测要求重新读取登录 Shell 与注册表环境，否则新装的 CLI 仍可能不可见。
    if (options.force === true) invalidateCommandEnvironment()

    const detection = custom === null
      ? await this.detectAutomatic()
      : await this.detectCandidate(custom, 'custom')
    this.cached = { key, detection, readAt: this.now() }
    return detection
  }

  /** 启用前使用：入口必须能运行并返回可识别的版本，否则允许的结论不成立。 */
  static isUsable(detection: MagpieInstallDetection): boolean {
    return detection.installed && detection.command !== null && detection.version !== null
  }

  private async detectAutomatic(): Promise<MagpieInstallDetection> {
    const candidates = await this.collectCandidates()
    let failure: { readonly command: string; readonly reason: MagpieDetectionFailure } | null = null
    for (const candidate of candidates) {
      const detection = await this.detectCandidate(candidate.command, candidate.source)
      if (detection.installed) return detection
      if (detection.reason !== null && failure === null) failure = { command: candidate.command, reason: detection.reason }
    }
    if (failure === null) return this.result({ installed: false, source: null, command: null, version: null, reason: null })
    // 入口存在却跑不起来：仍报告入口，让设置页能给出“已安装但不可用”的具体原因，
    // 而不是笼统的“未安装”。
    return this.result({ installed: true, source: null, command: failure.command, version: null, reason: failure.reason })
  }

  private async detectCandidate(command: string, source: MagpieInstallSource): Promise<MagpieInstallDetection> {
    const result = await this.runVersion(command, this.platform)
    if (result === null) return this.result({ installed: false, source: null, command: null, version: null, reason: null })
    const version = parseMagpieVersion(result.status, result.stdout, result.stderr)
    if (version !== null) return this.result({ installed: true, source, command, version, reason: null })
    const reason: MagpieDetectionFailure = result.timedOut
      ? 'timeout'
      : result.status === 0 && parseAnyVersion(`${result.stdout}\n${result.stderr}`) === null ? 'version' : 'launch'
    return this.result({ installed: true, source, command, version: null, reason })
  }

  /** 按平台给出候选入口；顺序即优先级，先把能直接运行的入口排在前面。 */
  private async collectCandidates(): Promise<readonly { readonly command: string; readonly source: MagpieInstallSource }[]> {
    const resolved = await this.resolvePath(MAGPIE_COMMAND, this.platform)
    const ordered: { readonly command: string; readonly source: MagpieInstallSource }[] = []
    if (resolved !== null) ordered.push({ command: resolved, source: 'path' })
    for (const candidate of this.platform === 'win32' ? await this.windowsCandidates() : await this.posixCandidates()) {
      if (!ordered.some((entry) => sameCommand(entry.command, candidate))) ordered.push({ command: candidate, source: 'common-location' })
    }
    return ordered
  }

  private async posixCandidates(): Promise<readonly string[]> {
    const directories = [
      // 登录 Shell 的完整 PATH：覆盖 Homebrew、nvm、fnm、volta 等只在 rc 文件里追加的目录。
      ...this.pathEntries().split(':'),
      ...POSIX_COMMON_BIN_DIRS,
      ...(this.environment.HOME === undefined ? [] : [
        join(this.environment.HOME, '.local', 'bin'),
        join(this.environment.HOME, '.bun', 'bin'),
        join(this.environment.HOME, '.npm-global', 'bin'),
      ]),
    ]
    const candidates: string[] = []
    for (const directory of uniqueDirectories(directories)) {
      const command = join(directory, MAGPIE_COMMAND)
      if (await this.isExecutable(command, this.platform)) candidates.push(command)
    }
    return candidates
  }

  private async windowsCandidates(): Promise<readonly string[]> {
    // 注入 Windows 平台时也要拼出 Windows 风格路径，不能用宿主（可能是 POSIX）的 join。
    const root = this.platform === 'win32' && process.platform !== 'win32' ? (value: string) => value : (value: string) => win32.normalize(value)
    const home = this.environment.USERPROFILE
    const appData = this.environment.APPDATA
    const localAppData = this.environment.LOCALAPPDATA
    const pathDirectories = this.pathEntries().split(';')
    const directories = [
      // The official installer puts the standalone command in this directory and adds it
      // to the per-user registry PATH; keep it explicit when the current PATH is stale.
      ...(home === undefined ? [] : [root(`${home}\\.local\\bin`)]),
      ...pathDirectories,
      ...(appData === undefined ? [] : [root(`${appData}\\npm`), root(`${appData}\\pnpm`)]),
      ...(localAppData === undefined ? [] : [
        root(`${localAppData}\\pnpm`),
        root(`${localAppData}\\Volta\\bin`),
        root(`${localAppData}\\Microsoft\\WinGet\\Links`),
        root(`${localAppData}\\Programs\\Magpie`),
      ]),
      ...(home === undefined ? [] : [
        root(`${home}\\.bun\\bin`),
        root(`${home}\\.cargo\\bin`),
        root(`${home}\\scoop\\shims`),
      ]),
    ]
    const candidates: string[] = []
    for (const directory of uniqueDirectories(directories)) {
      candidates.push(...await launchersIn(directory, this.listDirectory))
    }
    return candidates
  }

  private result(value: Omit<MagpieInstallDetection, 'platform' | 'checkedAt'>): MagpieInstallDetection {
    return {
      installed: value.installed,
      platform: hostPlatform(this.platform),
      source: value.source,
      command: value.command,
      version: value.version,
      reason: value.reason,
      checkedAt: new Date(this.now()).toISOString(),
    }
  }
}

/** 解析并规范化用户手工填写的入口；只接受绝对路径，拒绝参数与裸命令名。 */
export function normalizeCustomCommand(commandPath: string | undefined): string | null {
  if (typeof commandPath !== 'string') return null
  const value = commandPath.trim()
  if (value === '' || value.length > 4096) return null
  if (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value)) return null
  // 空白与 shell 元字符都可能把“路径”拆成多个参数或触发展开。
  if (/[\u0000-\u001f\u007f]|["'`$;&|<>\s]/u.test(value)) return null
  return value
}

/**
 * 解析 `magpie --version` 的输出。
 *
 * 只接受 256 字节以内的输出和「magpie <semver>」这一种形态：Magpie 目前输出纯版本号，
 * 解析失败时按“版本不支持”拒绝启用，而不是猜测。
 */
export function parseMagpieVersion(status: number | null, stdout: string, stderr: string): string | null {
  if (status !== 0) return null
  const combined = `${stdout}\n${stderr}`.trim()
  if (Buffer.byteLength(combined, 'utf8') > MAX_VERSION_OUTPUT_BYTES) return null
  return combined.match(/^magpie\s+v?(\d+\.\d+\.\d+)$/u)?.[1] ?? null
}

function parseAnyVersion(output: string): string | null {
  return output.match(/\d+\.\d+\.\d+/u)?.[0] ?? null
}

function hostPlatform(platform: NodeJS.Platform): MagpieHostPlatform {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  return 'linux'
}

function sameCommand(left: string, right: string): boolean {
  return WINDOWS ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** PATH 里常见的占位目录（空串、`.`）不参与探测，避免把当前目录当成安装位置。 */
function uniqueDirectories(directories: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const raw of directories) {
    const directory = raw.trim()
    if (directory === '' || directory === '.') continue
    const key = WINDOWS ? directory.toLowerCase() : directory
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(directory)
  }
  return unique
}

/** Windows 目录里可启动的 Magpie 入口；`.cmd`/`.bat` 由 shell 包装执行。 */
async function launchersIn(
  directory: string,
  listDirectory: (directory: string) => Promise<readonly string[]>,
): Promise<readonly string[]> {
  let entries: readonly string[]
  try { entries = await listDirectory(directory) } catch { return [] }
  const byName = new Map(entries.map((entry) => [entry.toLowerCase(), entry]))
  return WINDOWS_LAUNCHER_NAMES
    .map((name) => byName.get(name))
    .filter((entry): entry is string => entry !== undefined && EXECUTABLE_ENTRY.test(entry))
    .map((entry) => win32.join(directory, entry))
}

async function defaultListDirectory(directory: string): Promise<readonly string[]> {
  return readdir(directory)
}

async function defaultIsExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 按平台解析命令；生产环境的 `resolveCommandPath` 读取真实平台，因此注入
 * 其他平台时退回显式探测，保证测试不触发宿主登录 Shell。
 */
async function resolveCommandPathForPlatform(command: string, platform: NodeJS.Platform): Promise<string | null> {
  if (platform === process.platform) return resolveCommandPath(command)
  if (platform === 'win32') {
    const root = (process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows')
    const whereExe = `${root}\\System32\\where.exe`
    if (!(await defaultIsExecutable(whereExe, 'win32'))) return null
    const result = await runAsyncCommand(spawnSync, whereExe, [command], { timeout: 3_000, encoding: 'utf8' }).catch(() => null)
    const hit = `${result?.stdout ?? ''}`.split(/\r?\n/u).map((line) => line.trim()).find((line) => EXECUTABLE_ENTRY.test(line))
    return hit ?? null
  }
  return null
}

/** 直接运行入口的 `--version`；`.cmd`/`.bat` 在 Windows 上必须经 shell 启动。 */
async function runMagpieVersion(command: string, platform: NodeJS.Platform): Promise<MagpieCliRunResult | null> {
  try {
    await access(command, constants.F_OK)
  } catch {
    return null
  }
  try {
    const shell = platform === 'win32' && /\.(?:cmd|bat)$/iu.test(command)
    const invocation = shell ? windowsShellInvocation(command, ['--version']) : { command, args: ['--version'] }
    const result = await runAsyncCommand(spawnSync, invocation.command, [...invocation.args], {
      timeout: DETECTION_TIMEOUT_MS,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      env: { ...commandEnvironment(invocation.command), NO_COLOR: '1', FORCE_COLOR: '0' },
      ...(shell && WINDOWS ? { windowsVerbatimArguments: true } : {}),
    })
    const error = result.error as (Error & { code?: string; killed?: boolean }) | undefined
    const timedOut = error?.killed === true || error?.code === 'ETIMEDOUT' || result.signal !== null
    return { status: result.status, stdout: `${result.stdout ?? ''}`, stderr: `${result.stderr ?? ''}`, timedOut }
  } catch {
    return null
  }
}
