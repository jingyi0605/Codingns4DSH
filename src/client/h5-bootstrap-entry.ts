import { createHttpDshH5ControlApi, startDshH5BrowserBootstrap } from './dsh-h5-bootstrap.js'

/**
 * 独立 H5 静态项目使用的浏览器入口。
 * 这里故意只暴露无凭据的工厂和启动函数；Cookie 由浏览器自动管理，
 * 页面脚本永远拿不到 Control API 的 HttpOnly 会话内容。
 */
const runtime = {
  createHttpDshH5ControlApi,
  startDshH5BrowserBootstrap,
}

Object.defineProperty(globalThis, 'DshCodingNsH5', {
  configurable: true,
  enumerable: false,
  value: runtime,
  writable: false,
})

