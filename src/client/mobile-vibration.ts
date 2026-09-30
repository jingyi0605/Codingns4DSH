/**
 * Android 等移动浏览器的轻量触感反馈适配。
 *
 * 浏览器没有振动 API、页面不在可振动环境或调用被策略拒绝时，统一返回
 * false 并安静降级；移动端交互不能因为可选能力缺失而抛异常。
 */

export type MobileVibrationPattern = number | readonly number[]

export interface MobileVibrationNavigatorLike {
  vibrate?: (pattern: MobileVibrationPattern) => boolean | void
}
export interface MobileVibrationGlobalLike {
  navigator?: MobileVibrationNavigatorLike
}

/** 尝试触发一次振动；返回 true 表示浏览器接受了调用。 */
export function vibrateMobile(
  pattern: MobileVibrationPattern = 10,
  globalLike: MobileVibrationGlobalLike = globalThis as unknown as MobileVibrationGlobalLike,
): boolean {
  const navigatorLike = globalLike.navigator
  const vibrate = navigatorLike?.vibrate
  if (typeof vibrate !== 'function') return false
  try {
    return vibrate.call(navigatorLike, pattern) !== false
  } catch {
    return false
  }
}
