import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const profileRoot = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
const compatibility = manifest.engines?.dsh
const detected = detectRuntimeDshVersion()

// PATH 上的 `dsh` 只能证明机器上装了某个 DSH，不能证明它就是本次安装所使用的
// 运行时：桌面宿主经 scrubbedParentEnv() 派生子进程时会剥离全部 DSH_* 变量，
// 此时 PATH 里可能仍指向另一个（更旧的）dsh。把这种来源当成硬门禁会把正常安装
// 误判为不兼容，因此它只用于提示。
if (detected === undefined) {
  console.warn('DSH Profile 安装检查：未检测到当前 DSH 运行时，跳过安装期版本检查；运行期仍会再次校验')
  process.exit(0)
}

if (detected.source === 'path') {
  const verdict = isCompatible(detected.version, compatibility) ? '在' : '不在'
  console.warn(
    `DSH Profile 安装检查：PATH 上的 dsh ${detected.version} ${verdict} Profile 支持范围 ${String(compatibility)} 内，` +
      '但它未必是本次安装所使用的运行时，已跳过阻断',
  )
  process.exit(0)
}

if (!isCompatible(detected.version, compatibility)) {
  throw new Error(
    `DSH Profile 安装失败：当前 DSH ${detected.version} 不在 Profile 支持范围 ${String(compatibility)} 内` +
      `（版本来源：${detected.source}）`,
  )
}

console.log(
  `DSH Profile 安装期版本检查通过：DSH ${detected.version}（来源 ${detected.source}），兼容范围 ${compatibility}`,
)

/**
 * 读取当前 DSH 运行时版本，并标注来源。
 *
 * 优先级：宿主显式注入的版本 → Desktop Runtime 根（app.asar 内真实加载的包）
 * → 从 Profile 目录可解析到的 @deepseek-ai/dsh → PATH 上的 dsh。
 * 前三种来源能归属到本次安装真正使用的运行时，只有它们参与硬门禁。
 *
 * @returns {{ version: string, source: 'env' | 'runtime' | 'module' | 'path' } | undefined}
 */
function detectRuntimeDshVersion() {
  const injected = [process.env.DSH_RUNTIME_VERSION, process.env.DSH_VERSION].find(isVersion)
  if (injected !== undefined) return { version: injected, source: 'env' }

  const fromRuntime = readVersionFromRuntimeRoots()
  if (fromRuntime !== undefined) return { version: fromRuntime, source: 'runtime' }

  const fromModule = readVersionFromModule()
  if (fromModule !== undefined) return { version: fromModule, source: 'module' }

  const fromPath = readVersionFromCommand()
  if (fromPath !== undefined) return { version: fromPath, source: 'path' }

  return undefined
}

/** Electron 把 Resources 根暴露为 process.resourcesPath；纯 Node 下不存在。 */
function readVersionFromRuntimeRoots() {
  const resourcesRoot = process.resourcesPath
  if (typeof resourcesRoot !== 'string' || resourcesRoot.trim() === '') return undefined
  const runtimeRoots = [
    join(resourcesRoot, 'app.asar', 'dsh'),
    join(resourcesRoot, 'app.asar.unpacked', 'dsh'),
    join(resourcesRoot, 'dsh'),
  ]
  for (const runtimeRoot of runtimeRoots) {
    const version = readDshManifestVersion(
      join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    )
    if (version !== undefined) return version
  }
  return undefined
}

/** Profile 目录里若已装过 DSH，可直接解析其包清单。 */
function readVersionFromModule() {
  try {
    const require = createRequire(join(profileRoot, 'package.json'))
    return readDshManifestVersion(require.resolve('@deepseek-ai/dsh/package.json'))
  } catch {
    return undefined
  }
}

function readDshManifestVersion(manifestPath) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (parsed.name === '@deepseek-ai/dsh' && isVersion(parsed.version)) return parsed.version
  } catch {
    // 该路径没有 DSH 包时继续尝试下一个来源。
  }
  return undefined
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

function isVersion(value) {
  return typeof value === 'string' && VERSION_PATTERN.test(value)
}

function isCompatible(actual, range) {
  const match = typeof range === 'string' ? /^>=([^ ]+)(?: <=([^ ]+))?$/u.exec(range) : undefined
  if (!match) return false
  const actualVersion = parseVersion(actual)
  const minimum = parseVersion(match[1])
  if (!actualVersion || !minimum) return false
  if (match[2] === undefined) return compareVersions(actualVersion, minimum) >= 0
  const maximum = parseVersion(match[2])
  if (!maximum) return false
  return compareVersions(actualVersion, minimum) >= 0 && compareVersions(actualVersion, maximum) <= 0
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
