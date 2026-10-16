import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WINDOWS } from './process-utils.js'

/**
 * 桌面端 Agent 应用自带的 CLI 运行时。
 *
 * 这类 Agent 不是 PATH 上的命令，而是随桌面应用安装的 Node 入口（例如
 * ZCode 的 resources/glm/zcode.cjs）。发现结果只包含启动所需的路径与环境，
 * 凭据仍由 CLI 自己从用户目录读取，插件不接触任何令牌。
 */
export interface CodingNsDesktopAppRuntime {
  /** 适配器 ID，与 CLI 适配器名一致。 */
  readonly appId: string
  readonly appName: string
  readonly installRoot: string
  /** 随应用分发的 CLI 入口（Node 脚本）。 */
  readonly entry: string
  /** 已安装应用的包版本；无法读取包元数据时使用桌面端刷新的运行时版本。 */
  readonly appVersion: string | null
  /** 启动 CLI 所需的环境变量（provider 配置与数据目录）。 */
  readonly env: Readonly<Record<string, string>>
}

const ZCODE_ENTRY_SEGMENTS = ['resources', 'glm', 'zcode.cjs'] as const
const PROVIDER_CONFIG_SEGMENT = ['provider', 'zcode-builtin.json'] as const

/** Read the installed app's version, which can be newer than its last launched provider snapshot. */
export function readZcodePackagedVersion(resources: string): string | null {
  let file: number | undefined
  try {
    file = openSync(join(resources, 'app.asar'), 'r')
    const prefix = Buffer.alloc(16)
    if (readSync(file, prefix, 0, 16, 0) !== 16) return null
    const headerSize = prefix.readUInt32LE(4)
    const jsonSize = prefix.readUInt32LE(12)
    if (jsonSize > 16 * 1024 * 1024 || headerSize < jsonSize + 8) return null
    const header = Buffer.alloc(jsonSize)
    if (readSync(file, header, 0, jsonSize, 16) !== jsonSize) return null
    const entry = JSON.parse(header.toString('utf8')).files?.['package.json']
    const offset = Number(entry?.offset)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(entry?.size) || entry.size <= 0 || entry.size > 65_536) return null
    const bytes = Buffer.alloc(entry.size)
    if (readSync(file, bytes, 0, entry.size, 8 + headerSize + offset) !== entry.size) return null
    const metadata = JSON.parse(bytes.toString('utf8'))
    if (metadata.name !== '@zcode/desktop') return null
    const version: unknown = metadata.version
    return typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version) ? version : null
  } catch { return null } finally { if (file !== undefined) closeSync(file) }
}

function candidateRoots(appDirName: string): string[] {
  const roots = new Set<string>()
  const env = process.env
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs') : undefined]) {
    if (base !== undefined && base !== '') {
      roots.add(join(base, appDirName))
      roots.add(join(base, 'Zcode'))
      roots.add(join(base, 'ZCode'))
    }
  }
  if (WINDOWS) {
    // 桌面应用常被装到非系统盘（例如 D:\Program Files\Zcode），逐个盘符探测成本很低。
    for (let code = 65; code <= 90; code += 1) {
      const drive = String.fromCharCode(code)
      if (!existsSync(drive + ':\\')) continue
      roots.add(join(drive + ':\\', 'Program Files', appDirName))
      roots.add(join(drive + ':\\', 'Program Files (x86)', appDirName))
      roots.add(join(drive + ':\\', appDirName))
    }
  }
  if (!WINDOWS) {
    // macOS 应用通常位于系统 Applications 或用户 Applications 目录，且
    // 应用包名称在不同发行版中可能写成 ZCode/Zcode。
    for (const base of ['/Applications', join(homedir(), 'Applications')]) {
      for (const name of [appDirName, 'ZCode.app', 'Zcode.app']) roots.add(join(base, name))
    }
  }
  return [...roots]
}

function firstExisting(paths: readonly string[]): string | null {
  for (const path of paths) if (existsSync(path)) return path
  return null
}

/** 读取桌面应用刷新到用户目录的运行时 provider 配置（含当前模型目录）。 */
function resolveProviderRuntime(home: string): { configFile: string | null; appVersion: string | null } {
  const runtimeRoot = join(home, '.zcode', 'v2', 'runtime', 'provider')
  if (!existsSync(runtimeRoot)) return { configFile: null, appVersion: null }
  let best: { file: string; appVersion: string; mtimeMs: number } | null = null
  for (const platformDir of safeReaddir(runtimeRoot)) {
    for (const versionDir of safeReaddir(join(runtimeRoot, platformDir))) {
      for (const endpointDir of safeReaddir(join(runtimeRoot, platformDir, versionDir))) {
        const endpointRoot = join(runtimeRoot, platformDir, versionDir, endpointDir)
        for (const file of [join(endpointRoot, 'zcode-builtin.json'), join(endpointRoot, ...PROVIDER_CONFIG_SEGMENT)]) {
          if (!existsSync(file)) continue
          const mtimeMs = safeMtime(file)
          if (best === null || mtimeMs > best.mtimeMs) best = { file, appVersion: versionDir, mtimeMs }
        }
      }
    }
  }
  return best === null ? { configFile: null, appVersion: null } : { configFile: best.file, appVersion: best.appVersion }
}

function safeReaddir(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 发现 ZCode 桌面端自带的 CLI。
 *
 * provider 配置必须同时提供两份路径（CLI 才跳过内置发现逻辑）：
 * 桌面应用刷新出的活动配置与用户的个人配置规则。任一缺失时退回应用自带配置。
 */
export function resolveZCodeDesktopRuntime(): CodingNsDesktopAppRuntime | null {
  const root = firstExisting(candidateRoots('Zcode.app'))
  if (root === null) return null
  const directEntry = join(root, ...ZCODE_ENTRY_SEGMENTS)
  const bundleEntry = join(root, 'Contents', ...ZCODE_ENTRY_SEGMENTS)
  const entry = firstExisting([directEntry, bundleEntry])
  if (entry === null) return null
  const home = homedir()
  const runtime = resolveProviderRuntime(home)
  const personal = join(home, '.zcode', 'v2', 'provider_config.json')
  const resourceRoot = entry.endsWith(join(...ZCODE_ENTRY_SEGMENTS))
    ? join(entry, '..', '..')
    : join(root, 'Contents', 'Resources')
  const appVersion = readZcodePackagedVersion(resourceRoot) ?? runtime.appVersion
  const packaged = join(resourceRoot, 'config', ...PROVIDER_CONFIG_SEGMENT)
  const env: Record<string, string> = { ZCODE_DATA_BASE_DIR: home }
  const builtin = runtime.configFile ?? (existsSync(packaged) ? packaged : null)
  if (builtin !== null && existsSync(personal)) {
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal
  }
  if (appVersion !== null) env.ZCODE_APP_VERSION = appVersion
  return { appId: 'zcode', appName: 'ZCode', installRoot: root, entry, appVersion, env }
}

/** 启动桌面端 CLI 使用的 Node 运行时；桌面 Host 自身是 Electron，需要显式以 Node 方式复用。 */
export function desktopCliRuntimeCommand(): { command: string; env: Readonly<Record<string, string>> } {
  // 直接复用已运行的 Node，避免发现应用时再次启动登录 Shell。
  return { command: process.execPath, env: process.versions.electron !== undefined ? { ELECTRON_RUN_AS_NODE: '1' } : {} }
}
