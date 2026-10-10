import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const matrix = await readFile(join(root, 'src/dsh-capabilities/matrix.ts'), 'utf8')
const version = await readFile(join(root, 'version.json'), 'utf8').then(JSON.parse)
const failures = []
const notices = []

/**
 * 已知失效路由基线：`supportedDsh` 上界低于当前兼容下界，Registry 永远不会选中。
 *
 * 这些是 0.1.x 世代的路由，随兼容下界提升到 0.2.0-rc.2 后失效。基线让检查立刻可用：
 * 已登记项只提示、不阻塞；未登记的新增失效路由直接失败，防止技术债继续累积。
 * 清理一条就从这里删一条；基线项已不在矩阵中时会提示同步删除。
 */
const RETIRED_ROUTE_BASELINE = new Set([
  'config-forms',
  'conversation-events',
  'fixed-chevron-icon',
  'fixed-plus-icon',
  'legacy-rpc-handler',
  'legacy-settings-scope',
  'locale-runtime',
  'peer-aware-rpc-handler',
  'peer-host-aggregate',
  'peer-host-handshake',
  'peer-host-http-proxy',
  'peer-host-native-navigation-legacy',
  'peer-host-native-navigation-modern',
  'peer-host-relay-route',
  'peer-host-remote-web-context-fallback',
  'peer-host-store',
  'peer-host-ws-proxy',
  'peer-scope',
  'regular-chevron-icon',
  'regular-plus-icon',
  'remote-result',
  'sidebar-right-tabs',
  'theme-runtime',
])

// 规则 1：显式声明了退休时间（removableAfter）且当前测试版本已达到该时间。
for (const line of matrix.split('\n')) {
  if (!line.includes("'deprecated'")) continue
  const removal = [...line.matchAll(/'([^']+)'/gu)].at(-1)?.[1]
  const block = line.trim()
  if (removal === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(removal)) continue
  if (compare(version.dshTestedVersion, removal) >= 0) {
    failures.push(`路由已达到 removableAfter=${removal}，必须先移除矩阵、代码、测试和文档引用: ${block.slice(0, 120)}`)
  }
}

// 规则 2：事实上已失效 —— 路由版本上界低于插件兼容下界，Registry 永远不会选中它。
// 这条不依赖任何人工标记，因此每次提升兼容下界都会自动产出待清理清单。
const compatibility = /^>=([^ ]+)(?: <=([^ ]+))?$/u.exec(version.dshCompatibility ?? '')
const compatibilityFloor = compatibility?.[1]
const routes = parseMatrixRoutes(matrix)
const retiredRoutes = compatibilityFloor === undefined
  ? []
  : routes.filter((route) => {
    const upper = /^>=([^ ]+)(?: <=([^ ]+))?$/u.exec(route.supportedDsh)?.[2]
    return upper !== undefined && compare(upper, compatibilityFloor) < 0
  })

for (const route of retiredRoutes) {
  if (RETIRED_ROUTE_BASELINE.has(route.id)) continue
  const upper = route.supportedDsh.split(' ').at(-1)
  failures.push(
    `路由 ${route.id}（${route.capability}）上界 ${upper} 低于兼容下界 ${compatibilityFloor}，永远不会被选中：` +
    '请删除该路由，或登记进 check-capability-retirement.mjs 的 RETIRED_ROUTE_BASELINE',
  )
}

const retiredIds = new Set(retiredRoutes.map((route) => route.id))
for (const id of RETIRED_ROUTE_BASELINE) {
  if (!retiredIds.has(id)) notices.push(`基线中的 ${id} 已不在失效清单里，请从 RETIRED_ROUTE_BASELINE 移除`)
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
  const pattern = /route\(\s*'([^']+)',\s*'([^']+)',\s*'(?:host|client)',\s*(DSH_COMPATIBILITY|'[^']+')/gu
  const parsed = []
  for (const match of source.matchAll(pattern)) {
    parsed.push({
      capability: match[1],
      id: match[2],
      supportedDsh: match[3] === 'DSH_COMPATIBILITY' ? version.dshCompatibility : match[3].slice(1, -1),
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
