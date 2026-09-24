import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { runtime: 'src/client/h5-bootstrap-entry.ts' },
  // H5 Bootstrap 是独立部署项目，构建产物统一写入 git 忽略的 data/build。
  outDir: 'data/build/h5',
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  clean: false,
  treeshake: true,
  outputOptions: {
    codeSplitting: false,
    entryFileNames: 'runtime.js',
  },
})
