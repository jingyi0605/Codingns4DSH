import type { CodingNsAgentEvent } from '../../shared/contracts/cli-adapter.js'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'

const CITATION_PREFIX = ':codex-file-citation{'
type TextDelta = Extract<CodingNsAgentEvent, { readonly type: 'text-delta' }>

/** Codex 引用按正文 item 暂存，不能将半条指令提前追加到 DSH 的增量日志。 */
export class CodexFileCitationNormalizer {
  private readonly markdown = new MarkdownFileLinkNormalizer()
  private pending = ''
  private message: TextDelta | undefined

  *push(chunk: CodingNsAgentEvent): Generator<CodingNsAgentEvent> {
    for (const citation of this.pushCitation(chunk)) yield* this.markdown.push(citation)
  }

  *flush(): Generator<CodingNsAgentEvent> {
    for (const citation of this.flushCitations()) yield* this.markdown.push(citation)
    yield* this.markdown.flush()
  }

  private *pushCitation(chunk: CodingNsAgentEvent): Generator<CodingNsAgentEvent> {
    if (chunk.type !== 'text-delta') {
      // 用量和推理可以穿插在正文 delta 之间，不代表正文 item 已经结束。
      if (chunk.type !== 'usage' && chunk.type !== 'reasoning-delta' && chunk.type !== 'reasoning-snapshot') yield* this.flushCitations()
      yield chunk
      return
    }
    if (this.message?.messageId !== chunk.messageId) yield* this.flushCitations()
    this.message = chunk
    this.pending += chunk.text
    let text = ''
    while (this.pending !== '') {
      const start = this.pending.indexOf(CITATION_PREFIX)
      if (start < 0) {
        // 只保留可能是下一条指令开头的后缀；普通正文立即输出。
        let retained = Math.min(this.pending.length, CITATION_PREFIX.length - 1)
        while (retained > 0 && !CITATION_PREFIX.startsWith(this.pending.slice(-retained))) retained -= 1
        text += this.pending.slice(0, this.pending.length - retained)
        this.pending = retained === 0 ? '' : this.pending.slice(-retained)
        break
      }
      text += this.pending.slice(0, start)
      this.pending = this.pending.slice(start)
      const end = citationEnd(this.pending)
      if (end < 0) break
      const citation = this.pending.slice(0, end + 1)
      text += citationLink(citation)
      this.pending = this.pending.slice(end + 1)
    }
    if (text !== '') yield { ...chunk, text }
  }

  /** 消息、工具、step 和终态边界原样结算未闭合指令，保留所属 messageId。 */
  private *flushCitations(): Generator<CodingNsAgentEvent> {
    const text = this.pending
    this.pending = ''
    if (text !== '' && this.message !== undefined) yield { ...this.message, text }
    this.message = undefined
  }
}

/** 保留整条消息的 Markdown 上下文，只追加已确定的前缀，不能回写已发出的 delta。 */
class MarkdownFileLinkNormalizer {
  private source = ''
  private emitted = 0
  private message: TextDelta | undefined

  *push(chunk: CodingNsAgentEvent): Generator<CodingNsAgentEvent> {
    if (chunk.type !== 'text-delta') {
      if (chunk.type !== 'usage' && chunk.type !== 'reasoning-delta' && chunk.type !== 'reasoning-snapshot') yield* this.flush()
      yield chunk
      return
    }
    if (this.message?.messageId !== chunk.messageId) yield* this.flush()
    this.message = chunk
    const settled = this.emitted === this.source.length
    this.source += chunk.text
    // 已确定的上下文中，普通文字不改变链接/代码语法，无需重新解析整条消息。
    if (settled && !/[\[\]()`~\r\n]/u.test(chunk.text)) {
      this.emitted = this.source.length
      yield chunk
      return
    }
    yield* this.drain(false)
  }

  *flush(): Generator<CodingNsAgentEvent> {
    yield* this.drain(true)
    this.source = ''
    this.emitted = 0
    this.message = undefined
  }

  private *drain(final: boolean): Generator<CodingNsAgentEvent> {
    if (this.message === undefined || this.emitted === this.source.length) return
    const replacements: Array<{ start: number; end: number; text: string }> = []
    let safeEnd = this.source.length
    const visit = (node: Nodes): void => {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined || end <= this.emitted) return
      if (node.type === 'link') {
        const labelEnd = node.children.at(-1)?.position?.end.offset ?? start + 1
        const separator = this.source.indexOf('](', labelEnd)
        // 自动链接没有 ](；仅处理显式 Markdown 文件链接，保留标签、标题和括号。
        if (this.source[start] === '[' && separator >= start && separator < end) {
          let targetStart = separator + 2
          while (/\s/u.test(this.source[targetStart] ?? '')) targetStart += 1
          const angle = this.source[targetStart] === '<'
          const pathStart = targetStart + (angle ? 1 : 0)
          let pathEnd = pathStart
          let depth = 0
          for (; pathEnd < end; pathEnd += 1) {
            const character = this.source[pathEnd]!
            if (character === '\\') { pathEnd += 1; continue }
            if (angle) {
              if (character === '>') break
            } else {
              if (/\s/u.test(character) || (character === ')' && depth === 0)) break
              if (character === '(') depth += 1
              else if (character === ')') depth -= 1
            }
          }
          const target = this.source.slice(pathStart, pathEnd)
          const normalized = fileLineTarget(target)
          if (normalized !== target) replacements.push({ start: pathStart, end: pathEnd, text: normalized })
        }
        return
      }
      if (node.type === 'code') {
        // 未收到换行前，``` 仍可能变成普通行内文本（例如随后出现另一组反引号）。
        if (!final && !this.source.slice(start, end).includes('\n')) safeEnd = Math.min(safeEnd, start)
        return
      }
      if (node.type === 'inlineCode' || node.type === 'html' || node.type === 'image') return
      if (node.type === 'text' && !final) {
        // 未闭合的标签或代码跨度可能在后续分片中包住链接，必须等语法确定后再输出。
        for (let index = Math.max(start, this.emitted); index < end; index += 1) {
          const character = this.source[index]!
          if (character === '\\') { index += 1; continue }
          if (character === '[') {
            const close = this.source.indexOf(']', index + 1)
            if (close >= 0 && close + 1 < this.source.length && this.source[close + 1] !== '(') continue
          }
          const pendingFence = character === '~'
            && /^ {0,3}~*$/u.test(this.source.slice(this.source.lastIndexOf('\n', index - 1) + 1, index))
            && /^~*$/u.test(this.source.slice(index))
          if (character === '`' || character === '[' || pendingFence) {
            safeEnd = Math.min(safeEnd, index)
            break
          }
        }
      }
      if ('children' in node) for (const child of node.children) visit(child)
    }
    visit(fromMarkdown(this.source))
    safeEnd = Math.max(safeEnd, this.emitted)
    let cursor = this.emitted
    let text = ''
    for (const replacement of replacements) {
      if (replacement.start < cursor || replacement.end > safeEnd) continue
      text += this.source.slice(cursor, replacement.start) + replacement.text
      cursor = replacement.end
    }
    text += this.source.slice(cursor, safeEnd)
    this.emitted = safeEnd
    if (text !== '') yield { ...this.message, text }
  }
}

function fileLineTarget(target: string): string {
  const match = /:([1-9]\d*)$/u.exec(target)
  if (match === null || !Number.isSafeInteger(Number(match[1]))) return target
  const path = target.slice(0, match.index)
  // Windows 盘符不属于 URI scheme；裸盘符、真正的 URI 和已有片段保持原样。
  if (/^[a-z][\w+.-]*:/iu.test(path) && !/^[a-z]:[/\\]/iu.test(path)) return target
  if (/^[/\\]{2}/u.test(path) || /:\d+$/u.test(path)) return target
  if (/[?#\u0000-\u001f\u007f]/u.test(path) || !/[/\\.]/u.test(path)) return target
  return `${path}#L${match[1]}`
}

/** 引号里的花括号属于路径或属性，不能提前截断指令。 */
function citationEnd(text: string): number {
  let quote = ''
  for (let index = CITATION_PREFIX.length; index < text.length; index += 1) {
    const character = text[index]!
    if (quote !== '') {
      if (character === '\\' && (text[index + 1] === quote || text[index + 1] === '\\')) index += 1
      else if (character === quote) quote = ''
    } else if (character === '"' || character === "'") quote = character
    else if (character === '}') return index
  }
  return -1
}

function citationLink(citation: string): string {
  const attributes = citation.slice(CITATION_PREFIX.length, -1)
  const values = new Map<string, string>()
  // 保留 Windows 路径的字面反斜杠，不按 JSON 转义解释 \n、\t 等路径片段。
  const pattern = /\s*([\w-]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s"']+))/gu
  let consumed = 0
  for (const match of attributes.matchAll(pattern)) {
    if (match.index !== consumed || values.has(match[1]!)) return citation
    consumed = match.index + match[0].length
    values.set(match[1]!, match[2] ?? match[3] ?? match[4]!)
  }
  if (attributes.slice(consumed).trim() !== '') return citation
  const path = values.get('path')
  const purpose = values.get('purpose')
  if (values.get('mode') === 'live' || (purpose !== 'output' && purpose !== 'source') || path === undefined || path.trim() === '') return citation
  // 盘符不是 URI scheme；live 标识及真正的 URI 都不能作为本地文件打开。
  if (/^[a-z][\w+.-]*:/iu.test(path) && !/^[a-z]:[/\\]/iu.test(path)) return citation
  if (/[\u0000-\u001f\u007f]/u.test(path) || /^[/\\]{2}/u.test(path)) return citation
  // DSH Markdown 的 openFile delegate 接收本地路径，并沿当前会话路由到 Host。
  // 对路径逐段编码，避免空格、#、? 和 % 被误作 Markdown 或 URI 分隔符。
  const normalized = path.replace(/\\/gu, '/').replace(/^\/(?=[a-z]:\/)/iu, '')
  let target = normalized.split('/').map((segment) => encodeURIComponent(segment).replace(/%3A/giu, ':')).join('/')
  const start = values.get('line_start')
  const end = values.get('line_end')
  if (start !== undefined && /^[1-9]\d*$/u.test(start) && Number.isSafeInteger(Number(start))) {
    target += `#L${start}`
    if (end !== undefined && /^[1-9]\d*$/u.test(end) && Number.isSafeInteger(Number(end)) && Number(end) >= Number(start)) target += `-L${end}`
  }
  const label = path.replace(/[\\`*_[\]<>&]/gu, '\\$&')
  // 完整属性作为 Markdown title 保留下来，包括 purpose、行号和额外引用信息。
  const title = attributes.replace(/[\\"&]/gu, '\\$&')
  return `[${label}](<${target}> "${title}")`
}
