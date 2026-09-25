import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const matrix = await readFile(join(root, 'src/dsh-capabilities/matrix.ts'), 'utf8')
const rows = [...matrix.matchAll(/route\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*\[([^\]]*)\]/gu)]
  .map((match) => `| \`${match[1]}\` | \`${match[2]}\` | \`${match[3]}\` | \`${match[4]}\` | \`${match[5]}\` | ${match[6].replaceAll("'", '`')} |`)
const output = `# DSH 能力路由报告\n\n本文件由 scripts/generate-capability-report.mjs 根据 src/dsh-capabilities/matrix.ts 生成。\n\n| 能力 | 路由 | 运行时 | DSH 范围 | 状态 | 消费者 |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n`
const target = join(root, 'docs/生成报告/20260925-能力路由报告.md')
await writeFile(target, output, 'utf8')
console.log(`已生成 ${target}`)
