import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import './register-css-loader.mjs'

// 测试时直接在内存加载源码，不执行构建，也不依赖 Stage0 正在更新的 dist。
register('./source-loader.mjs', pathToFileURL('./tests/'))
