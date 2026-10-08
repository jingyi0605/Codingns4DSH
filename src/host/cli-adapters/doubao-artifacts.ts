/** 产物定位信息仅驻留本轮内存，不能作为工具参数、日志或会话持久化数据。 */
export interface DoubaoArtifact {
  readonly id: string
  readonly name: string
  readonly url: string
  readonly size?: number
}

type Data = Record<string, unknown>
const record = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}

/** 与工具展示分离：下载使用真实文件块，绝不从有长度限制的工具文本重建文件。 */
export class DoubaoArtifactCollector {
  private readonly files = new Map<string, Data>()

  accept(id: string, type: number, content: unknown, replace: boolean): void {
    if (type !== 10020) { this.files.delete(id); return }
    if (!this.files.has(id) && this.files.size >= 20) throw new Error('豆包单轮产物超过 20 个，已停止接收')
    const file = record(record(content).file_block)
    const previous = replace && Object.keys(file).length ? {} : this.files.get(id)
    // 只保留下载需要的字段；忽略云端 path，防止它被当成本机保存位置。
    const fields = Object.fromEntries(['name', 'url', 'size'].filter(key => file[key] !== undefined).map(key => [key, file[key]]))
    this.files.set(id, { ...previous, ...fields })
  }

  remove(id: string): void { this.files.delete(id) }

  /** 只在完整 SSE 正常结束后读取；缺失下载地址仍返回，由保存阶段报告明确失败。 */
  list(): DoubaoArtifact[] {
    const seen = new Set<string>()
    return [...this.files].flatMap(([id, file]) => {
      const url = typeof file.url === 'string' ? file.url : ''
      if (url && seen.has(url)) return []
      if (url) seen.add(url)
      const size = typeof file.size === 'number' || typeof file.size === 'string' && /^\d+$/u.test(file.size) ? Number(file.size) : undefined
      return [{ id, name: typeof file.name === 'string' ? file.name : '豆包产物', url,
        ...(size !== undefined && Number.isSafeInteger(size) && size >= 0 ? { size } : {}) }]
    })
  }
}
