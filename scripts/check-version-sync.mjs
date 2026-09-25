import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const readJson = async (relativePath) => JSON.parse(await readFile(join(root, relativePath), 'utf8'))
const versionFile = await readJson('version.json')
const manifest = await readJson('package.json')
const profile = await readJson('profile/package.json')
const profileVersionFile = await readJson('profile/version.json').catch(() => undefined)
const source = await readFile(join(root, 'src/shared/contracts/version.ts'), 'utf8')
const matrixSource = await readFile(join(root, 'src/dsh-capabilities/matrix.ts'), 'utf8')
const sourceDshVersion = /^export const DSH_VERSION = '([^']+)'/mu.exec(source)?.[1]
const sourcePluginVersion = /^export const CODINGNS_VERSION = '([^']+)'/mu.exec(source)?.[1]
const sourceCompatibility = /^export const DSH_COMPATIBILITY = '([^']+)'/mu.exec(source)?.[1]
const sourceProtocolVersion = /^export const DSH_PROTOCOL_VERSION = (\d+) as const/mu.exec(source)?.[1]
const pluginVersion = versionFile.pluginVersion
const dshCompatibility = versionFile.dshCompatibility
const dshVersion = versionFile.dshTestedVersion
const dshProtocolVersion = versionFile.dshProtocolVersion

const failures = []
const expectEqual = (label, actual, expected) => {
  if (actual !== expected) failures.push(`${label}: ${String(actual)} != ${String(expected)}`)
}

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const compatibility = /^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? <\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
if (typeof pluginVersion !== 'string' || !semver.test(pluginVersion)) failures.push(`version.json.pluginVersion 不是合法插件版本: ${String(pluginVersion)}`)
if (typeof dshVersion !== 'string' || !semver.test(dshVersion)) failures.push(`version.json.dshTestedVersion 不是合法 DSH 版本: ${String(dshVersion)}`)
if (typeof dshCompatibility !== 'string' || !compatibility.test(dshCompatibility)) failures.push(`version.json.dshCompatibility 不是受支持的 DSH 范围: ${String(dshCompatibility)}`)
if (!Number.isInteger(dshProtocolVersion) || dshProtocolVersion < 1) failures.push(`version.json.dshProtocolVersion 不是正整数: ${String(dshProtocolVersion)}`)
if (!matrixSource.includes('DSH_CAPABILITY_MATRIX') || !matrixSource.includes("'settings.store'")) failures.push('能力矩阵未声明 settings.store，无法作为版本兼容事实源')

const matrixRanges = [...matrixSource.matchAll(/'>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? <\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?'/gu)].map((match) => match[0].slice(1, -1))
const parseVersion = (value) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? '']
}
const compareVersion = (left, right) => {
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i]
  if (!left[3] && right[3]) return 1
  if (left[3] && !right[3]) return -1
  return String(left[3]).localeCompare(String(right[3]))
}
const compatibilityBounds = compatibility.exec(dshCompatibility)
if (compatibilityBounds && matrixRanges.length > 0) {
  const lower = parseVersion(compatibilityBounds[1])
  const upper = parseVersion(compatibilityBounds[2])
  const matrixBounds = matrixRanges.map((range) => /^>=([^ ]+) <([^ ]+)$/u.exec(range)).filter(Boolean)
  const matrixLower = matrixBounds.map((match) => parseVersion(match[1])).filter(Boolean).sort(compareVersion)[0]
  const matrixUpper = matrixBounds.map((match) => parseVersion(match[2])).filter(Boolean).sort(compareVersion).at(-1)
  if (lower && matrixLower && compareVersion(lower, matrixLower) < 0) failures.push(`manifest DSH 下界低于能力矩阵: ${dshCompatibility}`)
  if (upper && matrixUpper && compareVersion(upper, matrixUpper) > 0) failures.push(`manifest DSH 上界超出能力矩阵: ${dshCompatibility}`)
  if (dshVersion && !matrixBounds.some((match) => {
    const min = parseVersion(match[1]); const max = parseVersion(match[2]); const actual = parseVersion(dshVersion)
    return min && max && actual && compareVersion(actual, min) >= 0 && compareVersion(actual, max) < 0
  })) failures.push(`当前测试 DSH 版本不在能力矩阵中: ${dshVersion}`)
}

expectEqual('package.engines.dsh', manifest.engines?.dsh, dshCompatibility)
expectEqual('package.peerDependencies.@deepseek-ai/dsh', manifest.peerDependencies?.['@deepseek-ai/dsh'], dshCompatibility)
expectEqual('package.version', manifest.version, pluginVersion)
expectEqual('profile.version', profile.version, pluginVersion)
expectEqual('profile.engines.dsh', profile.engines?.dsh, dshCompatibility)
expectEqual('profile.dependencies.dsh-codingns', profile.dependencies?.['dsh-codingns'], pluginVersion)
if (profile.scripts?.preinstall !== 'node scripts/check-dsh-install.mjs') failures.push('profile.scripts.preinstall 未配置 DSH 安装期版本检查')
if (profileVersionFile !== undefined) {
  expectEqual('profile/version.json.pluginVersion', profileVersionFile.pluginVersion, pluginVersion)
  expectEqual('profile/version.json.dshCompatibility', profileVersionFile.dshCompatibility, dshCompatibility)
  expectEqual('profile/version.json.dshTestedVersion', profileVersionFile.dshTestedVersion, dshVersion)
}
expectEqual('src/shared/contracts/version.ts DSH_VERSION', sourceDshVersion, dshVersion)
expectEqual('src/shared/contracts/version.ts CODINGNS_VERSION', sourcePluginVersion, pluginVersion)
expectEqual('src/shared/contracts/version.ts DSH_COMPATIBILITY', sourceCompatibility, dshCompatibility)
expectEqual('src/shared/contracts/version.ts DSH_PROTOCOL_VERSION', sourceProtocolVersion, String(dshProtocolVersion))
for (const sectionName of ['dependencies', 'devDependencies']) {
  const section = manifest[sectionName] ?? {}
  for (const [name, version] of Object.entries(section)) {
    if (name.startsWith('@deepseek-ai/dsh-')) expectEqual(`${sectionName}.${name}`, version, dshVersion)
  }
}

if (failures.length > 0) {
  console.error(['DSH/CodingNS 版本未同步：', ...failures.map(item => `- ${item}`)].join('\n'))
  process.exitCode = 1
} else {
  console.log(`插件 ${pluginVersion} 兼容 DSH ${dshCompatibility}，当前测试版本 ${dshVersion}`)
}
