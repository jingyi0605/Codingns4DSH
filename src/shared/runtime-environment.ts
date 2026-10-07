/** Host 下发的运行环境标识；缺失或非布尔真值时按正式环境处理。 */
export const CODINGNS_STAGE0_GLOBAL = '__CODINGNS_STAGE0__'

/** 浏览器只读 Host 注入值，不依赖 process、端口、URL 或用户设置。 */
export function isInjectedStage0Runtime(scope: object = globalThis): boolean {
  return (scope as Record<string, unknown>)[CODINGNS_STAGE0_GLOBAL] === true
}
