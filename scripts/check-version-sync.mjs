import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const readJson = async (relativePath) => JSON.parse(await readFile(join(root, relativePath), 'utf8'))
const versionFile = await readJson('version.json')
const manifest = await readJson('package.json')
const profile = await readJson('profile/package.json')
const source = await readFile(join(root, 'src/shared/contracts/version.ts'), 'utf8')
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

expectEqual('package.engines.dsh', manifest.engines?.dsh, dshCompatibility)
expectEqual('package.version', manifest.version, pluginVersion)
expectEqual('profile.version', profile.version, pluginVersion)
expectEqual('profile.engines.dsh', profile.engines?.dsh, dshCompatibility)
expectEqual('profile.dependencies.dsh-codingns', profile.dependencies?.['dsh-codingns'], pluginVersion)
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
