import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const channel = /^(\d+\.\d+\.\d+)-(rc|beta|alpha)\./u

export function checkCandidateVersion(version, tags) {
  if (semver.valid(version) !== version || !/^\d+\.\d+\.\d+(?:-(?:\d+|(?:rc|beta|alpha)\.\d+))?$/u.test(version)) {
    return `不符合版本命名约定：${version}（使用稳定版、数字预发布或 rc.N / beta.N / alpha.N）`
  }
  const prefix = channel.exec(version)?.[0]
  if (prefix === undefined) return undefined
  const history = tags.map(tag => tag.replace(/^v/u, '')).filter(tag => tag.startsWith(prefix))
  const shape = (tag) => tag.replace(/\d+$/u, 'N')
  if (history.length > 0 && !history.some(tag => shape(tag) === shape(version))) {
    return `与同版本线、同类型的历史 tag 形式不一致：${history.join('、')}（本次为 ${version}）`
  }
}

if (import.meta.main) {
  const version = process.argv[2]?.trim() ?? ''
  const root = fileURLToPath(new URL('../', import.meta.url))
  const tags = channel.test(version)
    ? execFileSync('git', ['tag', '--list'], { cwd: root, encoding: 'utf8' }).split('\n')
    : []
  const problem = checkCandidateVersion(version, tags)
  if (problem === undefined) console.log(`版本号校验通过：${version}`)
  else {
    console.error(problem)
    process.exitCode = 1
  }
}
