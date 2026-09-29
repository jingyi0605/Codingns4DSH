import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const nextVersion = process.argv[2]?.trim()
const requestedCompatibility = process.argv[3]?.trim()
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const compatibilityPattern = /^>=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?: <=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?$/u
if (!nextVersion || !semver.test(nextVersion)) throw new Error('用法: pnpm run version:set-dsh -- 0.2.0-rc.1 [兼容范围]')
if (requestedCompatibility !== undefined && !compatibilityPattern.test(requestedCompatibility)) {
  throw new Error('DSH 兼容范围必须形如 ">=0.2.0-rc.1" 或 ">=0.2.0-rc.1 <=0.2.0-rc.2"')
}

const root = fileURLToPath(new URL('../', import.meta.url))
const readJson = async (relativePath) => JSON.parse(await readFile(join(root, relativePath), 'utf8'))
const writeJson = async (relativePath, value) => {
  await writeFile(join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`)
}

const versionFile = await readJson('version.json')
const previousVersion = versionFile.dshTestedVersion
const previousCompatibility = versionFile.dshCompatibility
const nextCompatibility = requestedCompatibility ?? createDefaultCompatibility(nextVersion, previousCompatibility)
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
const profileVersion = await readJson('profile/version.json')
profileVersion.dshTestedVersion = nextVersion
profileVersion.dshCompatibility = nextCompatibility
await writeJson('profile/version.json', profileVersion)

const versionPath = join(root, 'src/shared/contracts/version.ts')
const source = await readFile(versionPath, 'utf8')
const updated = source
  .replace(/^(export const DSH_VERSION = ')[^']+(' as const)$/mu, `$1${nextVersion}$2`)
  .replace(/^(export const DSH_COMPATIBILITY = ')[^']+(' as const)$/mu, `$1${nextCompatibility}$2`)
if (updated === source) throw new Error('没有找到 DSH_VERSION 或 DSH_COMPATIBILITY')
await writeFile(versionPath, updated)

for (const relativePath of ['README.md', 'README.en.md', 'profile/README.md']) {
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

function createDefaultCompatibility(version, previousCompatibility) {
  const floor = /^>=([^ ]+)/u.exec(previousCompatibility ?? '')?.[1]
  // 兼容范围只声明下界后，切换测试版本默认沿用现有下界，避免悄悄收紧插件支持范围。
  if (floor !== undefined && semver.test(floor) && compareVersion(floor, version) <= 0) return `>=${floor}`
  return `>=${version}`
}

function compareVersion(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value)
    return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''] : undefined
  }
  const a = parse(left); const b = parse(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index]
  if (!a[3] && b[3]) return 1
  if (a[3] && !b[3]) return -1
  const leftParts = a[3] ? a[3].split('.') : []
  const rightParts = b[3] ? b[3].split('.') : []
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
