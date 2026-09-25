import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const compatibility = manifest.engines?.dsh
const actualVersion = readRuntimeDshVersion()

// 普通 npm/pnpm 开发安装可能没有 DSH 宿主；这种场景没有可校验的目标，
// 不能把插件作为独立 npm 包安装的能力误判为失败。
if (actualVersion === undefined) {
  if (process.env.DSH_HOME !== undefined || process.env.DSH_PLUGIN_INSTALL === '1') {
    throw new Error('dsh-codingns 安装失败：检测到 DSH 安装上下文，但无法读取当前 DSH 版本')
  }
  console.warn('dsh-codingns: 未检测到 DSH 宿主，跳过安装期 DSH 兼容性检查')
  process.exit(0)
}

if (typeof compatibility !== 'string' || !isCompatible(actualVersion, compatibility)) {
  throw new Error(`dsh-codingns 安装失败：当前 DSH ${actualVersion} 不在插件支持范围 ${String(compatibility)} 内`)
}

console.log(`dsh-codingns 安装期版本检查通过：DSH ${actualVersion}，兼容范围 ${compatibility}`)

function readRuntimeDshVersion() {
  const candidates = [process.env.DSH_RUNTIME_VERSION, process.env.DSH_VERSION, readVersionFromCommand()]
  return candidates.find((value) => typeof value === 'string' && VERSION_PATTERN.test(value))
}

function readVersionFromCommand() {
  try {
    const result = spawnSync(process.platform === 'win32' ? 'dsh.cmd' : 'dsh', ['--version'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
    })
    if (result.status !== 0) return undefined
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().match(VERSION_PATTERN)?.[0]
  } catch {
    return undefined
  }
}

function isCompatible(actual, range) {
  const match = /^>=([^ ]+) <([^ ]+)$/u.exec(range)
  if (!match) return false
  const actualVersion = parseVersion(actual)
  const minimum = parseVersion(match[1])
  const maximum = parseVersion(match[2])
  if (!actualVersion || !minimum || !maximum) return false
  return compareVersions(actualVersion, minimum) >= 0 && compareVersions(actualVersion, maximum) < 0
}

function parseVersion(value) {
  const match = VERSION_PATTERN.exec(value)
  if (!match) return undefined
  const [major, minor, patch] = match[0].split('-')[0].split('.').map(Number)
  return {
    major,
    minor,
    patch,
    prerelease: match[0].includes('-') ? match[0].split('-')[1].split('.') : [],
  }
}

function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1
  if (left.prerelease.length > 0 && right.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumber = /^\d+$/u.test(leftPart)
    const rightNumber = /^\d+$/u.test(rightPart)
    if (leftNumber && !rightNumber) return -1
    if (!leftNumber && rightNumber) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}
