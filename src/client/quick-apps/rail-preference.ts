export const QUICK_APPS_RAIL_COLLAPSED_KEY = 'codingns4dsh.quickApps.railCollapsed'

/** Edit mode is a session action; only the collapsed rail is restored after reload. */
export function readQuickAppsRailCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(QUICK_APPS_RAIL_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export function writeQuickAppsRailCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(QUICK_APPS_RAIL_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // Restricted or private browsing keeps the in-memory rail mode only.
  }
}
