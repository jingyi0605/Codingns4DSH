import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const nextVersion = process.argv[2]?.trim()
const nextCompatibility = process.argv[3]?.trim() || createDefaultCompatibility(nextVersion)
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
if (!nextVersion || !semver.test(nextVersion)) throw new Error('用法: pnpm run version:set-dsh -- 0.1.7-rc.1 [兼容范围]')
if (!/^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? <\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(nextCompatibility)) {
  throw new Error('DSH 兼容范围必须形如 ">=0.1.6-alpha.2 <0.1.7"')
}

const root = fileURLToPath(new URL('../', import.meta.url))
const readJson = async (relativePath) => JSON.parse(await readFile(join(root, relativePath), 'utf8'))
const writeJson = async (relativePath, value) => {
  await writeFile(join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`)
}

const versionFile = await readJson('version.json')
const previousVersion = versionFile.dshTestedVersion
const previousCompatibility = versionFile.dshCompatibility
versionFile.dshTestedVersion = nextVersion
versionFile.dshCompatibility = nextCompatibility
await writeJson('version.json', versionFile)

const manifest = await readJson('package.json')
manifest.engines.dsh = nextCompatibility
for (const sectionName of ['dependencies', 'devDependencies']) {
  const section = manifest[sectionName] ?? {}
  for (const name of Object.keys(section)) {
    if (name.startsWith('@deepseek-ai/dsh-')) section[name] = nextVersion
  }
}
await writeJson('package.json', manifest)

const profile = await readJson('profile/package.json')
profile.engines.dsh = nextCompatibility
await writeJson('profile/package.json', profile)

const versionPath = join(root, 'src/shared/contracts/version.ts')
const source = await readFile(versionPath, 'utf8')
const updated = source
  .replace(/^(export const DSH_VERSION = ')[^']+(' as const)$/mu, `$1${nextVersion}$2`)
  .replace(/^(export const DSH_COMPATIBILITY = ')[^']+(' as const)$/mu, `$1${nextCompatibility}$2`)
if (updated === source) throw new Error('没有找到 DSH_VERSION 或 DSH_COMPATIBILITY')
await writeFile(versionPath, updated)

for (const relativePath of ['README.md', 'profile/README.md']) {
  const documentPath = join(root, relativePath)
  const document = await readFile(documentPath, 'utf8')
  let updatedDocument = document
  if (typeof previousVersion === 'string' && previousVersion !== nextVersion) updatedDocument = updatedDocument.replaceAll(previousVersion, nextVersion)
  if (typeof previousCompatibility === 'string' && previousCompatibility !== nextCompatibility) updatedDocument = updatedDocument.replaceAll(previousCompatibility, nextCompatibility)
  if (updatedDocument !== document) await writeFile(documentPath, updatedDocument)
}

console.log(`已将 DSH 测试版本切换为 ${nextVersion}`)
console.log(`当前插件兼容范围: ${nextCompatibility}`)
console.log('请随后运行 pnpm install --lockfile-only 和 pnpm run version:check')

function createDefaultCompatibility(version) {
  const match = /^(\d+\.\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(version ?? '')
  if (!match) return ''
  return `>=${version} <${match[1]}.${Number(match[2]) + 1}`
}
