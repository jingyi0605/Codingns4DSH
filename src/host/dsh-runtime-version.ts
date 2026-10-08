import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runAsyncCommand } from './cli-adapters/process-utils.js'
import { fileURLToPath } from 'node:url'
import {
  assertSupportedDshVersion,
  CODINGNS_DSH_VERSION_GLOBAL,
  CODINGNS_DSH_ERROR_CODES,
  CodingNsDshError,
} from '../shared/index.js'

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

/**
 * 读取当前 DSH 进程真正加载的 @deepseek-ai/dsh 版本。
 *
 * DSH 0.1.6 尚未把启动器版本作为 Cordis 服务暴露给插件，因此不能从
 * 插件自身的 DSH_VERSION 常量推断宿主版本。优先沿当前 dsh 可执行入口
 * 向上查找 @deepseek-ai/dsh/package.json。Desktop Host 额外传入 Runtime
 * 根目录，需要直接从该目录的 node_modules 读取实际加载的包版本；只有
 * 这些路径都无法提供版本时才回退到 PATH 中的 `dsh --version`。
 */
export async function detectRuntimeDshVersion(): Promise<string> {
  // 按优先级惰性读取；原先数组会先执行全部探测，即使环境变量已给出版本也会启动 CLI。
  const probes = [
    () => process.env.DSH_RUNTIME_VERSION,
    () => process.env.DSH_VERSION,
    ...process.argv.slice(1).map((path) => () => readDshVersionFromRuntimeRoot(path)),
    ...process.argv.slice(1).map((path) => () => readDshVersionFromModule(path)),
    () => readDshVersionsFromDesktopResources().find((value) => value !== undefined && VERSION_PATTERN.test(value)),
    () => readDshPackageVersion(process.argv[1]),
    () => readDshPackageVersion(fileURLToPath(import.meta.url)),
    () => readDshVersionFromCommand(),
  ]
  for (const probe of probes) {
    const version = await probe()
    if (version === undefined || !VERSION_PATTERN.test(version)) continue
    assertSupportedDshVersion(version)
    return version
  }
  throw new CodingNsDshError(
      CODINGNS_DSH_ERROR_CODES.DSH_VERSION_UNSUPPORTED,
      '无法读取当前 DSH 版本；为避免 API 不兼容，已拒绝启用 codingns4dsh',
    )
}

/** Host 启动后供 Web Client 复用的版本注入名称。 */
export const DSH_VERSION_INJECTION_NAME = CODINGNS_DSH_VERSION_GLOBAL

function readDshPackageVersion(entryPath: string | undefined): string | undefined {
  if (entryPath === undefined || entryPath.trim() === '') return undefined
  let current = dirname(entryPath)
  for (let depth = 0; depth < 10; depth += 1) {
    const manifestPath = join(current, 'package.json')
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
      if (manifest.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') return manifest.version
    } catch {
      // 当前目录不是 DSH 包时继续向上查找；读取失败不应掩盖后续探测路径。
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * Desktop 启动器把 Runtime 根目录作为 Host 参数传入，Host 入口本身与
 * @deepseek-ai/dsh 是兄弟目录，无法通过普通的父目录遍历找到它。
 */
function readDshVersionFromRuntimeRoot(runtimeRoot: string | undefined): string | undefined {
  if (runtimeRoot === undefined || runtimeRoot.trim() === '') return undefined

  const packageVersion = readDshPackageManifestVersion(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  if (packageVersion !== undefined) return packageVersion

  // 某些打包方式只保留 Runtime 根 package.json 的依赖声明。
  try {
    const manifest = JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    const declaredVersion = manifest.dependencies?.['@deepseek-ai/dsh'] ?? manifest.devDependencies?.['@deepseek-ai/dsh']
    return typeof declaredVersion === 'string' && VERSION_PATTERN.test(declaredVersion) ? declaredVersion : undefined
  } catch {
    return undefined
  }
}

/**
 * 让 Node/Electron 按 Desktop Host 自身的依赖边界解析 DSH。asar 内部路径
 * 由 Electron 的模块加载器处理，不能假设普通文件 API 能独立遍历所有目录。
 */
function readDshVersionFromModule(entryPath: string | undefined): string | undefined {
  if (entryPath === undefined || entryPath.trim() === '' || entryPath.startsWith('-')) return undefined
  try {
    const require = createRequire(entryPath)
    const manifestPath = require.resolve('@deepseek-ai/dsh/package.json') as string
    return readDshPackageManifestVersion(manifestPath)
  } catch {
    return undefined
  }
}

/** Electron 可能消费部分 argv；此时从自身 Resources 目录定位 Desktop Runtime。 */
function readDshVersionsFromDesktopResources(): Array<string | undefined> {
  const processWithResources = process as typeof process & { resourcesPath?: string }
  const resourcesRoots = [
    processWithResources.resourcesPath,
    join(dirname(dirname(process.execPath)), 'Resources'),
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== '')
  const runtimeRoots = resourcesRoots.flatMap((resourcesRoot) => [
    join(resourcesRoot, 'app.asar', 'dsh'),
    join(resourcesRoot, 'app.asar.unpacked', 'dsh'),
    join(resourcesRoot, 'dsh'),
  ])
  return runtimeRoots.flatMap((runtimeRoot) => [
    readDshVersionFromRuntimeRoot(runtimeRoot),
    readDshVersionFromModule(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')),
  ])
}

function readDshPackageManifestVersion(manifestPath: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown }
    if (manifest.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') return manifest.version
  } catch {
    return undefined
  }
  return undefined
}

async function readDshVersionFromCommand(): Promise<string | undefined> {
  try {
    const result = await runAsyncCommand(spawnSync, process.platform === 'win32' ? 'dsh.cmd' : 'dsh', ['--version'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    if (result.status !== 0) return undefined
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    return output.match(VERSION_PATTERN)?.[0]
  } catch {
    return undefined
  }
}
