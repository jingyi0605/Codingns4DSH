import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 日志只作后备证据：异步读取最近 64 个 run 的尾部，单文件最多 256 KiB。 */
export async function* readRecentLogTails(root: string, filename: string): AsyncGenerator<string> {
  let directories: string[]
  try {
    directories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse().slice(0, 64)
  } catch { return }
  for (const directory of directories) {
    const file = await open(join(root, directory, filename), 'r').catch(() => null)
    if (file === null) continue
    try {
      const { size } = await file.stat()
      const start = Math.max(0, size - 256 * 1024)
      const buffer = Buffer.alloc(Math.min(size, 256 * 1024))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
      const text = buffer.toString('utf8', 0, bytesRead)
      // 截断后的第一行不完整，不能把半行当成可信日志。
      yield start === 0 ? text : text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : ''
    } catch { /* 日志轮换或短暂读取失败时继续尝试前一个 run。 */ }
    finally { await file.close().catch(() => undefined) }
  }
}
