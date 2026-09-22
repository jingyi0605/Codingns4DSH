import type {
  CodingNsAgentQuestion,
  CodingNsAgentQuestionResponse,
} from '../../shared/contracts/cli-adapter.js'

/** 从不同 Provider 的问题结构中提取公共问题列表。 */
export function readAgentQuestions(value: unknown): readonly CodingNsAgentQuestion[] {
  const record = isRecord(value) ? value : null
  const source = Array.isArray(value)
    ? value
    : Array.isArray(record?.questions)
      ? record.questions
      : Array.isArray(record?.items)
        ? record.items
        : []
  return source.flatMap((item, index) => {
    const question = readQuestion(item, index)
    return question === null ? [] : [question]
  })
}

/** 把公共回答转换成 Provider 常用的 id -> answers 结构。 */
export function questionAnswersRecord(response: CodingNsAgentQuestionResponse): Record<string, { answers: string[] }> {
  return Object.fromEntries(response.answers.map((answer) => [
    answer.id,
    { answers: [...answer.selected, ...(answer.custom?.trim() ? [answer.custom.trim()] : [])] },
  ]))
}

/** 把公共回答转换成 ACP/OpenCode 常用的二维字符串数组。 */
export function questionAnswersList(response: CodingNsAgentQuestionResponse): string[][] {
  return response.answers.map((answer) => [
    ...answer.selected,
    ...(answer.custom?.trim() ? [answer.custom.trim()] : []),
  ])
}

export function isQuestionEvent(type: string): boolean {
  const normalized = type
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toLowerCase()
    .replace(/[./-]+/gu, '_')
  return normalized.includes('question') || normalized.includes('request_user_input') || normalized.includes('request_input') || normalized.includes('ask_user')
}

function readQuestion(value: unknown, index: number): CodingNsAgentQuestion | null {
  const record = isRecord(value) ? value : null
  const text = typeof value === 'string'
    ? value
    : firstString(record, ['question', 'prompt', 'message', 'text'])
  if (text === null || text.trim() === '') return null
  const optionsSource = Array.isArray(record?.options) ? record.options : Array.isArray(record?.choices) ? record.choices : []
  const options = optionsSource.flatMap((option) => {
    if (typeof option === 'string' && option.trim()) return [{ label: option.trim() }]
    if (!isRecord(option)) return []
    const label = firstString(option, ['label', 'value', 'name', 'title'])
    if (label === null || label.trim() === '') return []
    const description = firstString(option, ['description', 'detail'])
    return [{ label: label.trim(), ...(description?.trim() ? { description: description.trim() } : {}) }]
  })
  const id = firstString(record, ['id', 'questionId', 'question_id'])?.trim() || `question-${index + 1}`
  const detail = firstString(record, ['detail', 'description'])
  const header = firstString(record, ['header', 'title'])
  const multiSelect = record?.multiSelect === true || record?.multi_select === true || record?.multiple === true
  return {
    id,
    question: text.trim(),
    ...(detail?.trim() ? { detail: detail.trim() } : {}),
    ...(header?.trim() ? { header: header.trim() } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(multiSelect ? { multiSelect: true } : {}),
  }
}

function firstString(record: Record<string, unknown> | null, keys: readonly string[]): string | null {
  if (record === null) return null
  for (const key of keys) if (typeof record[key] === 'string') return record[key]
  return null
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
