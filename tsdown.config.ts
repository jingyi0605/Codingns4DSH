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
    entryFileNames: 'index.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-codingns", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
