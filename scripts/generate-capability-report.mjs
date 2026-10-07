import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const matrix = await readFile(join(root, 'src/dsh-capabilities/matrix.ts'), 'utf8')
const version = await readFile(join(root, 'version.json'), 'utf8').then(JSON.parse)
// 当前世代的路由使用共享兼容范围常量，不能在生成报告时漏掉这些路由。
const rows = [...matrix.matchAll(/route\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(?:'([^']+)'|(DSH_COMPATIBILITY)),\s*'([^']+)',\s*\[([^\]]*)\]/gu)]
  .map((match) => `| \`${match[1]}\` | \`${match[2]}\` | \`${match[3]}\` | \`${match[4] ?? version.dshCompatibility}\` | \`${match[6]}\` | ${match[7].replaceAll("'", '`')} |`)
const output = `# DSH 能力路由报告\n\n本文件由 scripts/generate-capability-report.mjs 根据 src/dsh-capabilities/matrix.ts 生成。\n\n| 能力 | 路由 | 运行时 | DSH 范围 | 状态 | 消费者 |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n## PeerHost 运行时边界\n\n能力矩阵中的 route 表示可注入的适配器边界，不等于目标 Host 的运行时能力已经验证。当前 PeerHost 的局域网握手、固定 HTTP/WS 白名单、HostScope 校验、实时事件过滤、有限重连和脱敏诊断已覆盖测试；聚合 source 未注入时必须返回 \`unsupported\`。\n\n\`peer-host.native-navigation\` 只有在结构探测到稳定 DSH 原生容器时才会挂载，缺失时保持 \`degraded\`，不得用 iframe 或 Remote Web Context 冒充原生三栏聚合。\`peer-host.relay-route\` 当前没有经过验证的 Host-to-Host 工作台 JSON/WS Transport，因此 relay PeerHost 必须保持 \`relay_unavailable/degraded\`，不能把浏览器 ticket 或任意公网 URL 当作可用中转。\n`
const target = join(root, 'docs/生成报告/20260925-能力路由报告.md')
await writeFile(target, output, 'utf8')
console.log(`已生成 ${target}`)
