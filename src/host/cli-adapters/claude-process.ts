import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { windowsShellInvocation } from './process-utils.js'

/**
 * Claude 的会话和模型发现共用同一启动边界。原生程序直接接收 argv；Windows
 * 包装器必须经过 cmd，但 JSON 和多行提示词不能参与 shell 的二次解析。
 */
export function spawnClaudeProcess(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  runSpawn: typeof spawn = spawn,
  platform: NodeJS.Platform = process.platform,
): ChildProcess {
  if (platform !== 'win32' || /\.(?:exe|com)$/iu.test(command)) {
    return runSpawn(command, args, { ...options, shell: false, windowsVerbatimArguments: false })
  }

  let directory: string | undefined
  const cleanup = (): void => {
    if (directory === undefined) return
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      directory = undefined
    } catch { /* Windows 文件句柄可能尚未释放；清理失败不能覆盖原始进程错误。 */ }
  }
  const writeArgument = (name: string, content: string): string => {
    // 在用户临时目录中隔离并发会话；支持 POSIX 权限时文件仅允许当前用户读写。
    directory ??= mkdtempSync(join(tmpdir(), 'codingns-claude-'))
    const path = join(directory, name)
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return path
  }

  try {
    const prepared = [...args]
    for (let index = 0; index < prepared.length - 1; index += 1) {
      const flag = prepared[index]
      const value = prepared[index + 1]!
      if (flag === '--mcp-config' && value.trimStart().startsWith('{')) {
        prepared[index + 1] = writeArgument(`mcp-${index}.json`, value)
        index += 1
      } else if (flag === '--append-system-prompt') {
        prepared[index] = '--append-system-prompt-file'
        prepared[index + 1] = writeArgument(`prompt-${index}.txt`, value)
        index += 1
      }
    }
    // 显式构造 /c 并保留引号，兼容带中文、空格和 & 的 .cmd 路径及空参数。
    const invocation = windowsShellInvocation(command, prepared, platform, options.env?.ComSpec ?? process.env.ComSpec)
    const child = runSpawn(invocation.command, invocation.args, { ...options, shell: false, windowsVerbatimArguments: true })
    child.once('error', cleanup)
    child.once('close', cleanup)
    return child
  } catch (error) {
    // 文件写入失败和 spawn 同步抛错都必须释放此前已经创建的文件。
    cleanup()
    throw error
  }
}
