import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// 宿主环境（例如 Desktop 内置终端）可能打开 Node 的实验性环境代理开关。该开关会让
// 每个 node 子进程在启动时向 stderr 打印 UNDICI-EHPA 告警，污染那些断言子进程
// stderr 原文的用例。测试进程不继承它，用例行为只由测试自身声明的环境决定。
delete process.env.NODE_USE_ENV_PROXY

// Node 原生测试运行器不会处理上游 DSH UI 原语导入的 CSS 模块；注册轻量加载器，
// 让测试只读取 CSS 文本，不改变生产构建和浏览器端样式行为。
register('./css-loader.mjs', pathToFileURL('./tests/'))

// 默认完整测试读取实际构建产物，同时支持用源码路径声明的模块和测试夹具。
// register-source-loader.mjs 后注册的源码加载器仍可覆盖此解析，用于免构建回归。
register('./built-module-loader.mjs', pathToFileURL('./tests/'))
