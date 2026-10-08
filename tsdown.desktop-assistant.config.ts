import { defineConfig } from 'tsdown'

/** 原生伴随页没有 DSH ModuleLoader；React 与形象渲染器必须随独立入口打包。 */
export default defineConfig({
  entry: { 'desktop-assistant': 'src/client/avatar/desktop-entry.ts' },
  outDir: 'data/build/dist/client', format: 'iife', platform: 'browser', target: 'es2022',
  define: { 'process.env.NODE_ENV': '"production"' },
  noExternal: () => true, dts: false, sourcemap: false, clean: false,
  outputOptions: { codeSplitting: false, entryFileNames: 'desktop-assistant.js' },
})
