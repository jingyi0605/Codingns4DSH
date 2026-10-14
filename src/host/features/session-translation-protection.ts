import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'

interface TextRange {
  readonly start: number
  readonly end: number
}

const voidElements = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '))

/** Keep source slices locally; only placeholders and prose reach the translation model. */
export function protectText(value: string): { readonly text: string; readonly values: readonly string[] } {
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
  ranges = mergeRanges([...ranges, ...markupRanges(markupSource)])
  ranges = mergeRanges([...ranges, ...collectInGaps(value, ranges, literalRanges)])

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
function markupRanges(value: string): TextRange[] {
  const ranges: TextRange[] = []
  const stack: { name: string; start: number }[] = []
  const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^>"']|"[^"]*"|'[^']*')*>|<\/?([\p{L}_][\p{L}\p{N}_:.-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/giu
  for (const match of value.matchAll(tags)) {
    const tag = match[0]
    const name = match[1]?.toLowerCase()
    const end = match.index + tag.length
    ranges.push({ start: match.index, end })
    if (name === undefined) continue
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
  const literals = /@@CODINGNS_TRANSLATION_\d+@@|https?:\/\/[^\s)]+|(?:^|\s)(?:[~/][^\s]+|[A-Za-z]:\\[^\s]+)(?=\s|$)|(?:^|\n)[ \t]*(?:[$>#]\s+|(?:npm|pnpm|yarn|bun|git|node|python|python3|cargo|docker|kubectl|curl|ssh|chmod|chown|mkdir|rmdir|rm|cp|mv|ls|cat|echo|export|make)\s+)[^\n]+/gimu
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
