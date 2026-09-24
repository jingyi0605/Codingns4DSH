import { readFile } from 'node:fs/promises'

const tag = process.env.GITHUB_REF_NAME ?? process.argv[2]
const versionFile = JSON.parse(await readFile(new URL('../version.json', import.meta.url), 'utf8'))
const expectedVersion = versionFile.version
const actualVersion = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : undefined

if (typeof actualVersion !== 'string' || actualVersion === '') {
  throw new Error(`发布 tag 必须使用 v<版本> 格式，实际值为: ${String(tag)}`)
}
if (actualVersion !== expectedVersion) {
  throw new Error(`发布 tag 与 version.json 不一致: tag=${actualVersion}, version.json=${expectedVersion}`)
}

console.log(`发布版本校验通过: ${tag} -> ${expectedVersion}`)
