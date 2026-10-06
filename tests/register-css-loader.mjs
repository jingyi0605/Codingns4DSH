import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// Node 原生测试运行器不会处理上游 DSH UI 原语导入的 CSS 模块；注册轻量加载器，
// 让测试只读取 CSS 文本，不改变生产构建和浏览器端样式行为。
register('./css-loader.mjs', pathToFileURL('./tests/'))
