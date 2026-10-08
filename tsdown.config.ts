import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { clientChunkBanner, nativeClientChunksPlugin } from './scripts/client-chunks.mjs'

const require = createRequire(import.meta.url)
const XTERM_CSS_ID = '@xterm/xterm/css/xterm.css'
const XTERM_CSS_VIRTUAL_ID = '\0codingns4dsh:xterm-css'

export default defineConfig({
  entry: { index: 'src/client/index.ts' },
  outDir: 'data/build/dist/client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // 浏览器没有 Node process；在编译期消除 React DOM 等依赖的环境分支。
  // 只替换 NODE_ENV，保留共享调试模块对 Host 环境变量的受控读取。
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: {
    '.png': 'dataurl',
    '.svg': 'dataurl',
    '.css': 'text',
  },
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
    alwaysBundle: (specifier) => specifier !== 'react' && specifier !== '@deepseek-ai/dsh-client-ui-primitives',
  },
  plugins: [nativeClientChunksPlugin(), {
    name: 'codingns4dsh:xterm-css-text',
    enforce: 'pre',
    resolveId(source) {
      return source === XTERM_CSS_ID ? XTERM_CSS_VIRTUAL_ID : null
    },
    load(id) {
      if (id !== XTERM_CSS_VIRTUAL_ID) return null
      // xterm 样式只进入终端 Shadow DOM，不能作为全局 CSS 资产输出。
      const path = require.resolve(XTERM_CSS_ID)
      this.addWatchFile(path)
      const css = readFileSync(path, 'utf8')
      return `export default ${JSON.stringify(css)}`
    },
  }],
  outputOptions: {
    codeSplitting: true,
    // 与 tsc 的 data/build/dist/client/index.js 分离，避免两个监听进程互相覆盖产物。
    entryFileNames: 'bundle.js',
    // 文件名稳定，修订号由整个分块图写入入口，并由 DSH 原生 rev 查询参数隔离缓存。
    chunkFileNames: 'client.[name].js',
    // DSH Client 以 npm 包名作为模块表 ID；必须与 scoped 包名完全一致。
    banner: clientChunkBanner,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
