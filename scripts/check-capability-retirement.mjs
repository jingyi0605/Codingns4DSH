import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const matrix = await readFile(join(root, 'src/dsh-capabilities/matrix.ts'), 'utf8')
const version = await readFile(join(root, 'version.json'), 'utf8').then(JSON.parse)
const failures = []
const notices = []

const compatibility = /^>=([^ ]+)$/u.exec(version.dshCompatibility ?? '')
const compatibilityFloor = compatibility?.[1]
const routes = parseMatrixRoutes(matrix)
const retiredRoutes = compatibilityFloor === undefined
  ? []
  : routes.filter((route) => {
    const upper = /^>=([^ ]+)(?: <=([^ ]+))?$/u.exec(route.supportedDsh)?.[2]
    return upper !== undefined && compare(upper, compatibilityFloor) < 0
  })

const activeCapabilities = new Set(routes.filter((route) => route.status === 'supported' && !retiredRoutes.includes(route)).map((route) => route.capability))
for (const route of routes) {
  if (retiredRoutes.includes(route) && route.status !== 'deprecated') {
    failures.push(`路由 ${route.id}（${route.capability}）低于兼容下界 ${compatibilityFloor}，请在矩阵标为 deprecated`)
  }
  if (route.status !== 'deprecated') continue
  if (!activeCapabilities.has(route.replacement) || !parse(route.removableAfter ?? '')) {
    failures.push(`弃用路由 ${route.id} 必须声明仍可用的替代能力和合法的 removableAfter`)
  } else if (compare(version.dshTestedVersion, route.removableAfter) >= 0) {
    failures.push(`路由 ${route.id} 已达到 removableAfter=${route.removableAfter}，必须清理矩阵、代码、测试和文档引用`)
  }
}
if (retiredRoutes.length > 0) {
  notices.push(`失效路由 ${retiredRoutes.length} 条（兼容下界 ${compatibilityFloor}），矩阵共 ${routes.length} 条、有效 ${routes.length - retiredRoutes.length} 条`)
}

if (notices.length > 0) console.log(['能力退休检查提示：', ...notices.map((item) => `- ${item}`)].join('\n'))
if (failures.length > 0) {
  console.error(['能力退休检查失败：', ...failures.map((item) => `- ${item}`)].join('\n'))
  process.exitCode = 1
} else {
  console.log('能力退休检查通过：没有到期的旧路由，也没有新增的失效路由')
}

/**
 * 解析能力矩阵里的路由行。
 *
 * 只匹配 `route(...)` 调用本身，因此不受注释影响；`DSH_COMPATIBILITY` 常量按当前
 * 兼容范围展开，避免矩阵与 manifest 各存一份事实。
 */
function parseMatrixRoutes(source) {
  const pattern = /route\(\s*'([^']+)',\s*'([^']+)',\s*'(?:host|client)',\s*(DSH_COMPATIBILITY|'[^']+'),\s*'([^']+)',\s*\[[^\]]*\](?:,\s*'([^']+)',\s*'([^']+)')?\s*\)/gu
  const parsed = []
  for (const match of source.matchAll(pattern)) {
    parsed.push({
      capability: match[1],
      id: match[2],
      supportedDsh: match[3] === 'DSH_COMPATIBILITY' ? version.dshCompatibility : match[3].slice(1, -1),
      status: match[4],
      replacement: match[5],
      removableAfter: match[6],
    })
  }
  return parsed
}

function compare(left, right) {
  const a = parse(left); const b = parse(right)
  if (!a || !b) return -1
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
    if (leftNumber && !rightNumber) return -1
    if (!leftNumber && rightNumber) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function parse(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''] : undefined
}
