export interface PeerHostFileLocation {
  readonly path: string
  readonly line?: number
}

/**
 * Windows 消息链接常写成 `/C:/项目/文件.md:170`，但斜杠和行号都不是文件名。
 * 仅在目标工作区使用 Windows 路径时纠正，保留 POSIX 下合法的冒号文件名。
 * 工作区未知时不猜平台，也不依赖当前客户端或代理 Host 的操作系统。
 */
export function normalizePeerHostFileLocation(path: string, workspacePath: string | undefined): PeerHostFileLocation {
  if (workspacePath === undefined || !/^(?:[a-z]:[/\\]|[/\\]{2})/iu.test(workspacePath)) return { path }
  const normalized = path.replace(/^\/(?=[a-z]:[/\\])/iu, '')
  // 盘符冒号后不是数字，不会被当成行号；同时兼容 `:行:列` 的位置写法。
  const match = /:(\d+)(?::(\d+))?$/u.exec(normalized)
  if (match === null) return { path: normalized }
  const line = Number(match[1])
  const column = match[2] === undefined ? undefined : Number(match[2])
  if (!Number.isSafeInteger(line) || line < 1 || (column !== undefined && (!Number.isSafeInteger(column) || column < 1))) return { path: normalized }
  return { path: normalized.slice(0, match.index), line }
}
