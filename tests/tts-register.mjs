import { register } from 'node:module'

// 只在内存中转译仓库源码，使定向回归不触发被禁止的构建或服务启动。
register('./tts-source-loader.mjs', import.meta.url)
