import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 版本事实源是 version.json；本脚本不再硬编码任何 DSH 版本，避免每次升级
// 都要在源码、脚本、测试里各改一遍同样的字面量。
const root = fileURLToPath(new URL('../', import.meta.url))
const versionFile = JSON.parse(await readFile(join(root, 'version.json'), 'utf8'))
const expected = versionFile.dshTestedVersion
const compatibility = versionFile.dshCompatibility
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const lockfile = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8')
const failures = []

const dshDependencies = Object.entries({
  ...manifest.dependencies,
  ...manifest.devDependencies,
}).filter(([name]) => name.startsWith('@deepseek-ai/dsh'))

for (const [name, version] of dshDependencies) {
  if (version !== expected) failures.push(`${name} 声明为 ${String(version)}，必须精确固定为 ${expected}`)
  const importer = new RegExp(`^\\s{6}'?${escapeRegExp(name)}'?[\\s\\S]*?^\\s{8}specifier: ([^\\n]+)`, 'mu').exec(lockfile)
  if (importer?.[1]?.trim() !== expected) failures.push(`pnpm-lock importer 中 ${name} 为 ${importer?.[1]?.trim() ?? '缺失'}，必须为 ${expected}`)
}

// 允许声明上下界；声明上界时必须覆盖当前测试版本，否则门禁会把已安装的
// 运行时判为范围外。
if (manifest.engines?.dsh !== compatibility) failures.push(`engines.dsh 与 version.json.dshCompatibility 不一致：${String(manifest.engines?.dsh)} != ${compatibility}`)
if (manifest.peerDependencies?.['@deepseek-ai/dsh'] !== compatibility) failures.push(`peerDependencies.@deepseek-ai/dsh 与 version.json.dshCompatibility 不一致：${String(manifest.peerDependencies?.['@deepseek-ai/dsh'])} != ${compatibility}`)

// Desktop runtime 校验按「兼容范围」而非「精确等于测试版本」：
// rc.2 到当前测试版本 alpha.1 都可用，范围外版本必须明确拒绝。
// 若这里用精确比较，就会出现「安装期放行、矩阵检查拒绝」的自相矛盾。
const runtimeRoot = process.argv[2] ?? process.env.DSH_DESKTOP_RUNTIME_ROOT
if (runtimeRoot) {
  // 桌面 runtime 根的布局随发行方式不同：有的是 node_modules 平铺，有的只有
  // runtime.json 描述文件。两种都探，都探不到就明确报告路径，不抛未捕获异常。
  const candidates = [
    { label: 'node_modules/@deepseek-ai/dsh/package.json', path: join(runtimeRoot, 'node_modules/@deepseek-ai/dsh/package.json') },
    { label: 'runtime.json', path: join(runtimeRoot, 'runtime.json') },
    { label: 'desktop-runtime.json', path: join(runtimeRoot, 'desktop-runtime.json') },
  ]
  const found = candidates.filter((candidate) => existsSync(candidate.path))
  if (found.length === 0) {
    failures.push(`Desktop runtime 根 ${runtimeRoot} 下未找到可识别的版本描述文件（已尝试：${candidates.map((candidate) => candidate.label).join('、')}）`)
  }
  for (const candidate of found) {
    let document
    try {
      document = JSON.parse(await readFile(candidate.path, 'utf8'))
    } catch (error) {
      failures.push(`Desktop runtime 的 ${candidate.label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    // package.json 用 version，runtime.json / desktop-runtime.json 用 desktopVersion 或 release.version。
    const declared = document.version ?? document.desktopVersion ?? document.release?.version
    if (typeof declared !== 'string') {
      failures.push(`Desktop runtime 的 ${candidate.label} 未声明可识别的 DSH 版本`)
      continue
    }
    if (!isVersionInRange(declared, compatibility)) {
      failures.push(`Desktop runtime 的 DSH 版本 ${declared} 不在插件兼容范围 ${compatibility} 内（来源：${candidate.label}）`)
    }
    const mismatches = (document.sharedPackages ?? [])
      .filter((item) => typeof item?.name === 'string' && item.name.startsWith('@deepseek-ai/dsh') && !isVersionInRange(item.version, compatibility))
    if (mismatches.length > 0) {
      failures.push(`Desktop runtime 存在超出兼容范围的 DSH 包：${mismatches.map((item) => `${item.name}@${item.version}`).join(', ')}`)
    }
  }
}

if (failures.length > 0) {
  console.error([`DSH ${expected} 依赖矩阵校验失败：`, ...failures.map((failure) => `- ${failure}`)].join('\n'))
  process.exit(1)
}

console.log(`DSH ${expected} 依赖矩阵校验通过：${dshDependencies.length} 个 DSH 依赖精确锁定`)

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** 与 src/dsh-capabilities/registry.ts 同构的范围判定；声明上界时同时校验上限。 */
function isVersionInRange(version, range) {
  const match = /^>=([^ ]+)(?: <=([^ ]+))?$/u.exec(range)
  const actual = parseVersion(version)
  const minimum = parseVersion(match?.[1] ?? '')
  if (match === null || actual === undefined || minimum === undefined) return false
  if (compareVersion(actual, minimum) < 0) return false
  if (match[2] === undefined) return true
  const maximum = parseVersion(match[2])
  return maximum !== undefined && compareVersion(actual, maximum) <= 0
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(String(value))
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? '']
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index]
  if (!left[3] && right[3]) return 1
  if (left[3] && !right[3]) return -1
  const leftParts = left[3] ? left[3].split('.') : []
  const rightParts = right[3] ? right[3].split('.') : []
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index]
    const rightPart = rightParts[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftNumber = /^\d+$/u.test(leftPart)
    const rightNumber = /^\d+$/u.test(rightPart)
    if (leftNumber && rightNumber) return Number(leftPart) - Number(rightPart)
    if (leftNumber) return -1
    if (rightNumber) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}
