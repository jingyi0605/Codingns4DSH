import type { CodingNsAgentToolEvent } from '../../shared/contracts/cli-adapter.js'

type Data = Record<string, unknown>
interface Source { title: string; url?: string; summary?: string }
interface ToolData {
  title?: string
  summary?: string
  text?: string
  file?: string
  size?: string
  format?: string
  toolName?: string
  status?: string
  queries?: string[]
  sources?: Source[]
}
interface ToolState { data: ToolData; name: string; finished: boolean; signature: string }

// 类型及字段来自 App 2.12.8 的枚举和实际流。代码块 10008 只是内容，不是执行证据。
const definitions: Record<number, { key: string; name: string }> = {
  10006: { key: 'link_reader_block', name: '豆包网页读取' },
  10019: { key: 'file_operation_block', name: '豆包云端文件操作' },
  10020: { key: 'file_block', name: '豆包云端产物' },
  10024: { key: 'generic_tool_block', name: '豆包云端工具' },
  10025: { key: 'search_query_result_block', name: '豆包联网搜索' },
  10101: { key: 'loading_block', name: '豆包处理进度' },
}
const record = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
const limit = (text: string, length: number): string => text.length > length ? `${text.slice(0, length)}\n...[内容已截断]` : text

/** 仅展示普通网页来源，不把签名下载链接、内嵌凭据或非网页协议写入工具历史。 */
function sourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    if ([...url.searchParams.keys()].some(key => /token|auth|signature|credential|^sig$|^x-amz-|^x-oss-/iu.test(key))) return undefined
    url.hash = ''
    return url.href
  } catch { return undefined }
}

function text(value: unknown, length = 8192, preserveWhitespace = false): string | undefined {
  if (typeof value !== 'string') return undefined
  const safe = value.replace(/https?:\/\/[^\s<>"'\])]+/gu, url => sourceUrl(url) ?? '[链接已隐藏]')
    .replace(/\bBearer\s+[\w.+/=-]+/giu, 'Bearer [已隐藏]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
  return limit(preserveWhitespace ? safe : safe.trim(), length)
}

function sources(value: unknown, cards: boolean): Source[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.slice(0, 20).map(item => {
    const source = cards ? record(record(item).text_card) : record(item)
    const url = sourceUrl(source.url)
    const summary = text(source.summary, 512)
    return { title: text(source.title, 256) || '网页来源', ...(url ? { url } : {}), ...(summary ? { summary } : {}) }
  })
}

/** 只保存选定的展示字段，不缓存整块 Provider 响应。缺省字段保留给后续补丁合并。 */
function readData(type: number, source: Data): ToolData {
  const result: ToolData = {}
  const scalars = {
    title: source.title ?? record(source.header).summary,
    summary: source.summary,
    text: type === 10101 ? record(source.text_loading).text : type === 10019 ? source.content : type === 10006 ? source.description : undefined,
    file: type === 10020 ? source.name : type === 10019 ? source.file_name : undefined,
    size: type === 10020 ? (typeof source.size === 'number' ? String(source.size) : source.size) : undefined,
    format: type === 10020 ? source.type : undefined,
    toolName: source.tool_name,
    // 不猜测各块不同的数字状态枚举；明确字符串失败才转为失败事件。
    status: typeof source.status === 'string' ? source.status.toLowerCase() : undefined,
  }
  for (const [key, value] of Object.entries(scalars)) {
    const safe = text(value, key === 'text' ? 8192 : 1024, key === 'text')
    if (safe !== undefined) Object.assign(result, { [key]: safe })
  }
  if (type === 10025 && Array.isArray(source.queries)) result.queries = source.queries.slice(0, 20).map(query => text(query, 512)).filter((query): query is string => !!query)
  const entries = sources(type === 10025 ? source.results : type === 10006 ? source.items : undefined, type === 10025)
  if (entries !== undefined) result.sources = entries
  return result
}

function toolInput(data: ToolData): string {
  return JSON.stringify({ scope: '豆包云端',
    ...(data.title || data.summary || data.text ? { summary: limit(data.title || data.summary || data.text || '', 1024) } : {}),
    ...(data.queries ? { queries: data.queries } : {}),
    ...(data.file ? { file: data.file } : {}),
    ...(data.format ? { format: data.format } : {}),
    ...(data.size ? { size: data.size } : {}),
    ...(data.toolName ? { tool: data.toolName } : {}),
  })
}

function toolOutput(type: number, data: ToolData, fallback: string): string {
  if (type === 10020) return `产物：${data.file || '未命名文件'}${data.size ? `（${data.size} 字节）` : ''}。请在豆包会话中打开或下载。`
  const entries = data.sources?.map((source, index) => [
    `${index + 1}. ${source.title}`, source.url, source.summary,
  ].filter(Boolean).join('\n')) ?? []
  return limit([data.title, data.summary, data.text,
    data.queries?.length ? `搜索词：${data.queries.join('；')}` : '', ...entries,
  ].filter(Boolean).join('\n\n') || fallback, 24_000)
}

/** 工具仅观察豆包云端执行；同一个 blockId 始终只有一个工具生命周期。 */
export class DoubaoToolProjector {
  private readonly states = new Map<string, ToolState>()

  accept(id: string, type: number, content: unknown, replace: boolean, finished: boolean): CodingNsAgentToolEvent[] {
    const definition = definitions[type]
    if (!definition) return []
    const previous = this.states.get(id)
    if (previous?.finished || !previous && this.states.size >= 256) return []
    const source = record(record(content)[definition.key])
    const incoming = readData(type, source)
    // 云端操作的 content 是文本补丁；标题等元数据仍按快照更新。
    if (!replace && type === 10019 && incoming.text !== undefined && previous?.data.text) {
      incoming.text = limit(previous.data.text + incoming.text, 8192)
    }
    if (!replace && incoming.queries && previous?.data.queries) incoming.queries = [...new Set([...previous.data.queries, ...incoming.queries])].slice(0, 20)
    if (!replace && incoming.sources && previous?.data.sources) {
      incoming.sources = [...new Map([...previous.data.sources, ...incoming.sources].map(item => [item.url ?? item.title, item])).values()].slice(0, 20)
    }
    // is_finish 单独到达时仍须保留已展示的数据；真正替换的内容块才清除旧快照。
    const data = { ...(replace && Object.keys(source).length ? {} : previous?.data), ...incoming }
    const failed = ['failed', 'error', 'cancelled', 'canceled'].includes(data.status ?? '')
    const name = previous?.name ?? (type === 10024 && data.toolName ? `${definition.name}：${data.toolName}` : definition.name)
    const output = toolOutput(type, data, name)
    const terminal = finished || failed
    const signature = JSON.stringify({ data, terminal })
    if (signature === previous?.signature) return []
    this.states.set(id, { data, name, finished: terminal, signature })
    return [{ type: 'tool-event', callId: id, toolName: name,
      status: failed ? 'failed' : terminal ? 'completed' : previous ? 'running' : 'started',
      input: toolInput(data), detail: data.title || data.summary || name,
      output, outputMode: 'snapshot', ...(failed ? { error: output } : {}),
    }]
  }

  remove(id: string): CodingNsAgentToolEvent[] {
    const previous = this.states.get(id)
    if (!previous || previous.finished) return []
    previous.finished = true
    const error = '豆包已撤回此工具记录，未确认执行完成'
    return [{ type: 'tool-event', callId: id, toolName: previous.name, status: 'failed', error, output: error, outputMode: 'snapshot' }]
  }
}
