import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'

interface TextRange {
  readonly start: number
  readonly end: number
}

const voidElements = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '))
const promptWrappers = new Set(['system-reminder', 'available_skills'])

export interface TextProtectionOptions {
  readonly literals?: readonly string[]
  /** Only host-owned prompt messages may expose prose inside these known wrappers. */
  readonly promptMarkup?: boolean
}

/** Numbers, dates, and numeric expressions have no prose to translate. */
export function isLanguageNeutralText(value: string): boolean {
  return /\p{N}/u.test(value) && /^[\p{N}\p{P}\p{S}\s]+$/u.test(value)
}

/**
 * 只由代码标识符组成的文本（如 `STAGE0_INITIAL_OK`、`sourceLanguage`、`Node.js`、`9fd2d5d`）
 * 没有可翻译的自然语言。模型会按保留规则原样返回，再按目标语言校验就会被误判为失败。
 * 普通单词（如 `OK`、`Done`）不属于标识符，仍交给翻译模型处理。
 */
export function isCodeIdentifierText(value: string): boolean {
  const tokens = value.trim().split(/\s+/u)
    .map(token => token.replace(/^["'`([{「“‘]+|["'`)\]}」”’.,;:!?。，；：！？]+$/gu, ''))
    .filter(token => token !== '')
  return tokens.length > 0
    && tokens.some(token => /\p{L}/u.test(token))
    && tokens.every(token => isLanguageNeutralText(token) || isCodeIdentifier(token))
}

function isCodeIdentifier(token: string): boolean {
  if (!/^[A-Za-z0-9_.-]+$/u.test(token) || !/[A-Za-z]/u.test(token)) return false
  return /_/u.test(token)
    || /\d/u.test(token)
    || /^[a-z]+(?:[A-Z][a-z0-9]*)+$/u.test(token)
    || /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/u.test(token)
}

/** Keep source slices locally; only placeholders and prose reach the translation model. */
export function protectText(value: string, options: TextProtectionOptions = {}): { readonly text: string; readonly values: readonly string[] } {
  const knownRanges: TextRange[] = []
  for (const literal of options.literals ?? []) {
    if (literal === '') continue
    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(literal)
    const partOfToken = (character: string | undefined): boolean => character !== undefined && /[A-Za-z0-9_.\\/-]/u.test(character)
    let start = value.indexOf(literal)
    while (start >= 0) {
      const end = start + literal.length
      if (!identifier || !partOfToken(value[start - 1]) && !partOfToken(value[end])) knownRanges.push({ start, end })
      start = value.indexOf(literal, start + literal.length)
    }
  }
  let ranges: TextRange[] = []
  const blocks: TextRange[] = []
  const visit = (node: Nodes): void => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) {
        ranges.push({ start, end })
        if (node.type === 'code') blocks.push({ start, end })
      }
    } else if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(fromMarkdown(value))

  // JSON strings may contain backticks; their enclosing document owns those spans.
  ranges = mergeRanges([...ranges, ...collectInGaps(value, blocks, jsonRanges)])
  let markupSource = ''
  let cursor = 0
  for (const range of ranges) {
    // Keep offsets while hiding tags inside code. An outer element can still enclose code.
    markupSource += value.slice(cursor, range.start) + value.slice(range.start, range.end).replace(/[^\r\n]/g, ' ')
    cursor = range.end
  }
  markupSource += value.slice(cursor)
  ranges = mergeRanges([...ranges, ...markupRanges(markupSource, options.promptMarkup === true)])
  // Merge known values after recognizing whole paths so a known cwd cannot split a longer path.
  ranges = mergeRanges([...ranges, ...knownRanges, ...collectInGaps(value, ranges, literalRanges)])

  const values: string[] = []
  let text = ''
  cursor = 0
  for (const range of ranges) {
    text += value.slice(cursor, range.start) + `@@CODINGNS_TRANSLATION_${values.length}@@`
    values.push(value.slice(range.start, range.end))
    cursor = range.end
  }
  return { text: text + value.slice(cursor), values }
}

function collectInGaps(value: string, ranges: readonly TextRange[], collect: (value: string) => TextRange[]): TextRange[] {
  const additions: TextRange[] = []
  let cursor = 0
  for (const range of [...ranges, { start: value.length, end: value.length }]) {
    for (const item of collect(value.slice(cursor, range.start))) {
      additions.push({ start: cursor + item.start, end: cursor + item.end })
    }
    cursor = range.end
  }
  return additions
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  const merged: TextRange[] = []
  for (const range of ranges.sort((left, right) => left.start - right.start || right.end - left.end)) {
    const last = merged.at(-1)
    if (last === undefined || range.start >= last.end) merged.push(range)
    else if (range.end > last.end) merged[merged.length - 1] = { start: last.start, end: range.end }
  }
  return merged
}

/** Match whole paired elements, including their text, without consuming adjacent prose. */
function markupRanges(value: string, promptMarkup: boolean): TextRange[] {
  const ranges: TextRange[] = []
  const stack: { name: string; start: number }[] = []
  const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^>"']|"[^"]*"|'[^']*')*>|<\/?([\p{L}_][\p{L}\p{N}_:.-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/giu
  for (const match of value.matchAll(tags)) {
    const tag = match[0]
    const name = match[1]?.toLowerCase()
    const end = match.index + tag.length
    ranges.push({ start: match.index, end })
    if (name === undefined) continue
    if (promptMarkup && promptWrappers.has(name)) continue
    if (tag.startsWith('</')) {
      let opening = stack.length - 1
      while (opening >= 0 && stack[opening]!.name !== name) opening--
      if (opening >= 0) {
        ranges.push({ start: stack[opening]!.start, end })
        stack.length = opening
      }
    } else if (!voidElements.has(name) && !tag.endsWith('/>')) {
      stack.push({ name, start: match.index })
    }
  }
  return ranges
}

/** Only valid JSON objects/arrays qualify; ordinary braces and Markdown links remain prose. */
function jsonRanges(value: string): TextRange[] {
  const ranges: TextRange[] = []
  let start = -1
  let quoted = false
  const stack: string[] = []
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (start < 0) {
      if (character !== '{' && character !== '[') continue
      start = index
    }
    if (quoted) {
      if (character === '\\') index++
      else if (character === '"') quoted = false
    } else if (character === '"') quoted = true
    else if (character === '{' || character === '[') stack.push(character)
    else if (character === '}' || character === ']') {
      const opening = stack.pop()
      if ((character === '}' ? '{' : '[') !== opening) stack.length = 0
      if (stack.length === 0) {
        try {
          JSON.parse(value.slice(start, index + 1))
          ranges.push({ start, end: index + 1 })
        } catch { /* An invalid candidate remains translatable text. */ }
        start = -1
      }
    }
  }
  return ranges
}

function literalRanges(value: string): TextRange[] {
  const ranges: TextRange[] = []
  // Unquoted paths stop at Chinese prose punctuation; quoted/known literals may contain it.
  const literals = /@@CODINGNS_TRANSLATION_\d+@@|\{\{[a-z][a-z0-9_]*\}\}|(?:https?|file):\/\/[^\s)]+|["'「](?:[~/]|\.\.?\/|\\\\|[A-Za-z]:[\\/]|(?:[\p{L}\p{N}_.-]+[\\/])+)[^"'」\r\n]+["'」]|(?<![\p{L}\p{N}_])(?:~\/|\.\.?\/|\/|\\\\|[A-Za-z]:[\\/]|(?:[\p{L}\p{N}_.-]+[\\/])+)[^\s"'<>「」，。；：！？、]+|(?:^|\n)[ \t]*(?:[$>#]\s+|(?:npm|pnpm|yarn|bun|git|node|python|python3|cargo|docker|kubectl|curl|ssh|chmod|chown|mkdir|rmdir|rm|cp|mv|ls|cat|echo|export|make)\s+)[^\n]+/gimu
  for (const match of value.matchAll(literals)) {
    const leadingSpace = match[0].length - match[0].trimStart().length
    ranges.push({ start: match.index + leadingSpace, end: match.index + match[0].length })
  }
  return ranges
}

export function stripPlaceholders(value: string): string {
  return value.replace(/@@CODINGNS_TRANSLATION_\d+@@/gu, ' ')
}

/** Missing, duplicated, or unknown markers invalidate the response instead of corrupting code. */
export function restoreText(value: string, values: readonly string[]): string {
  const seen = new Set<number>()
  const restored = value.replace(/@@CODINGNS_TRANSLATION_(\d+)@@/gu, (match, index: string) => {
    const position = Number(index)
    const original = values[position]
    if (original === undefined || seen.has(position) || match !== `@@CODINGNS_TRANSLATION_${position}@@`) {
      throw new Error('translation changed protected text placeholders')
    }
    seen.add(position)
    return original
  })
  if (seen.size !== values.length) throw new Error('translation omitted protected text placeholders')
  return restored
}
