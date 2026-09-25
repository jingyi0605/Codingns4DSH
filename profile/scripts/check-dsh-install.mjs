import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const profileRoot = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
const actualVersion = readVersionFromCommand()

if (actualVersion === undefined) {
  throw new Error('DSH Profile 安装失败：无法读取当前 DSH 版本，拒绝继续安装插件')
}

if (!isCompatible(actualVersion, manifest.engines?.dsh)) {
  throw new Error(`DSH Profile 安装失败：当前 DSH ${actualVersion} 不在 Profile 支持范围 ${String(manifest.engines?.dsh)} 内`)
}

console.log(`DSH Profile 安装期版本检查通过：DSH ${actualVersion}`)

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
  const match = typeof range === 'string' ? /^>=([^ ]+) <([^ ]+)$/u.exec(range) : undefined
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
  return { major, minor, patch, prerelease: match[0].includes('-') ? match[0].split('-')[1].split('.') : [] }
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
