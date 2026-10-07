import { defineConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

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
  external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
  noExternal: (specifier) => specifier !== 'react' && specifier !== '@deepseek-ai/dsh-client-ui-primitives',
  plugins: [{
    name: 'codingns4dsh:xterm-css-text',
    enforce: 'pre',
    resolveId(source) {
      return source === XTERM_CSS_ID ? XTERM_CSS_VIRTUAL_ID : null
    },
    load(id) {
      if (id !== XTERM_CSS_VIRTUAL_ID) return null
      // xterm 样式只进入终端 Shadow DOM，不能作为全局 CSS 资产输出。
      const css = readFileSync(require.resolve(XTERM_CSS_ID), 'utf8')
      return `export default ${JSON.stringify(css)}`
    },
  }],
  outputOptions: {
    codeSplitting: false,
    // 与 tsc 的 data/build/dist/client/index.js 分离，避免两个监听进程互相覆盖产物。
    entryFileNames: 'bundle.js',
    // DSH Client 以 npm 包名作为模块表 ID；必须与 scoped 包名完全一致。
    banner: 'window.__ModuleLoader__.load({ id: "@jingyi0605/codingns4dsh", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
