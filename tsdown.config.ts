import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/client/index.ts' },
  outDir: 'dist/client',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: ['react'],
  noExternal: (specifier) => specifier !== 'react',
  outputOptions: {
    // 与 tsc 的 dist/client/index.js 分离，避免两个监听进程互相覆盖产物。
    entryFileNames: 'bundle.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-codingns", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
