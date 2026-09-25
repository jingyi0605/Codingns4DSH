import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
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
 * 向上查找 @deepseek-ai/dsh/package.json，只有开发环境无法提供入口时才
 * 回退到 PATH 中的 `dsh --version`。
 */
export function detectRuntimeDshVersion(): string {
  const candidates = [
    process.env.DSH_RUNTIME_VERSION,
    process.env.DSH_VERSION,
    readDshPackageVersion(process.argv[1]),
    readDshPackageVersion(fileURLToPath(import.meta.url)),
    readDshVersionFromCommand(),
  ]
  const version = candidates.find((candidate) => candidate !== undefined && VERSION_PATTERN.test(candidate))
  if (version === undefined) {
    throw new CodingNsDshError(
      CODINGNS_DSH_ERROR_CODES.DSH_VERSION_UNSUPPORTED,
      '无法读取当前 DSH 版本；为避免 API 不兼容，已拒绝启用 dsh-codingns',
    )
  }
  assertSupportedDshVersion(version)
  return version
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

function readDshVersionFromCommand(): string | undefined {
  try {
    const result = spawnSync(process.platform === 'win32' ? 'dsh.cmd' : 'dsh', ['--version'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
    })
    if (result.status !== 0) return undefined
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    return output.match(VERSION_PATTERN)?.[0]
  } catch {
    return undefined
  }
}
