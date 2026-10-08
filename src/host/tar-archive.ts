import { win32 } from 'node:path'

/**
 * 系统解压器：Windows 明确选择系统 bsdtar，避免 Git GNU tar 将盘符识别为远程主机。
 *
 * 语音运行环境与 Live2D 引擎都只需要解压固定格式的归档，共用同一解析规则，
 * 不引入额外依赖，也不执行远程安装脚本。
 */
export function systemTarCommand(platform: string = process.platform, environment: NodeJS.ProcessEnv = process.env): string {
  if (platform !== 'win32') return 'tar'
  const value = (name: string): string | undefined => Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1]
  const root = value('SYSTEMROOT') || value('WINDIR')
  if (!root || !win32.isAbsolute(root)) throw new Error('无法定位 Windows 系统解压器，请检查 SystemRoot 环境变量')
  return win32.join(root, 'System32', 'tar.exe')
}
