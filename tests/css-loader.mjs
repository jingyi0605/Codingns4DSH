import { readFile } from 'node:fs/promises'

/** 将测试环境中的 CSS 模块转换成默认导出文本。 */
export async function load(url, context, nextLoad) {
  if (!url.endsWith('.css')) return nextLoad(url, context)
  const source = await readFile(new URL(url), 'utf8')
  return {
    format: 'module',
    shortCircuit: true,
    source: `export default ${JSON.stringify(source)}`,
  }
}
