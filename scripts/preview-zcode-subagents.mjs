/** Build a standalone preview of the actual registered plugin UI. Never installs. */
import { readFile, mkdir, writeFile, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { build } from 'tsdown'
import { fileURLToPath } from 'node:url'
export async function buildSubagentPreview(destination = process.env.ZCODE_SUBAGENT_PREVIEW ?? '.agent-temp/zcode-preview') {
const output = resolve(destination)
const intermediate = resolve(`.agent-temp/${new Date().toISOString().slice(0,10)}-zcode-preview`)
await mkdir(output, { recursive: true }); await mkdir(intermediate, { recursive: true })
const buildDir = await mkdtemp(join(intermediate, 'preview-build-'))
await build({ config: false, entry: ['tests/fixtures/zcode-native-preview.ts'], outDir: buildDir, platform: 'browser', format: 'iife', dts: false, sourcemap: false, clean: false, define: { 'process.env.NODE_ENV': '"production"' }, deps: { alwaysBundle: () => true, onlyBundle: false } })
const bundle = await readFile(join(buildDir, 'zcode-native-preview.iife.js'), 'utf8')
const theme = (await Promise.all(['base.css', 'design-platform.css'].map(file => readFile(`node_modules/@deepseek-ai/dsh-client-ui-theme/src/styles/${file}`, 'utf8')))).join('\n')
await writeFile(join(output, 'preview.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZCode 子智能体与工作流 · 样式预览</title><style>${theme}
body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:14px/1.5 var(--dsw-font-family)}
.preview-top{max-width:720px;margin:28px auto 18px;padding:0 20px}.preview-top h1{font-size:20px;font-weight:500;margin:0 0 6px}.preview-top p{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0 0 16px}
.preview-tools{display:flex;gap:6px;flex-wrap:wrap}.preview-tools button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;min-height:32px;padding:4px 12px;border-radius:8px;cursor:pointer}.preview-tools button[aria-pressed=true],.preview-tools button:hover{background:var(--dsw-alias-interactive-bg-hover)}
#root{max-width:720px;margin:auto;padding:0 20px}.preview-session{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;border-top:.5px solid var(--dsw-alias-border-l3);padding:14px 0;container-type:inline-size}.preview-session>span{font-size:13px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
</style><body data-ds-dark-theme><div class="preview-top"><h1>子智能体与工作流</h1><p>本地样式预览 · 示例数据 · 未安装</p><nav class="preview-tools"><button data-preview-mode="both" aria-pressed="true">混合展示</button><button data-preview-mode="native" aria-pressed="false">子智能体</button><button data-preview-mode="workflow" aria-pressed="false">工作流</button><button data-preview-theme>切换明暗</button></nav></div><div id="root"></div><script>${bundle.replaceAll('</script', '<\\/script')}</script></body></html>`)
console.log(`Preview only (not installed): ${join(output, 'preview.html')}`)
return join(output, 'preview.html')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSubagentPreview(process.argv[2])
