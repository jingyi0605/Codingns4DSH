import {
  questionTranslationFields, translatedField,
  type InteractionAnswer, type InteractionTranslationField, type InteractionTranslationResult, type TranslatableQuestion,
} from '../../shared/contracts/interaction-translation.js'

/** Read complete recorded JSON only. Preparing or unrecognized tool shapes remain native. */
export function readQuestionHistory(block: any, settled?: InteractionAnswer['answers']) {
  const call = block?.kind === undefined ? block : block.call
  const args = parseRecord(call?.argsRaw)
  const questions = args?.questions
  if (!Array.isArray(questions) || !questions.every(isQuestion)) return undefined
  const text = Array.isArray(block?.content) && block.content.length === 1 && block.content[0]?.type === 'text' ? block.content[0].text : undefined
  const output = parseRecord(text)
  const answers = settled ?? (validAnswers(output?.answers) ? output.answers : [])
  return { args: args!, questions: questions as readonly TranslatableQuestion[], answers: answers as InteractionAnswer['answers'], output, call }
}

export function questionHistoryFields(history: NonNullable<ReturnType<typeof readQuestionHistory>>): InteractionTranslationField[] {
  return [...questionTranslationFields(history.questions), ...history.answers.flatMap((answer, index) => [
    ...answer.selected.map((text, choice) => ({ key: `a.${index}.s.${choice}`, text })),
    ...(answer.custom ? [{ key: `a.${index}.custom`, text: answer.custom }] : []),
  ])]
}

/** Clones for rendering only: callbacks, logged arguments, and wire answers keep their source values. */
export function displayQuestionHistory(block: any, history: NonNullable<ReturnType<typeof readQuestionHistory>>, result: InteractionTranslationResult) {
  const questions = history.questions.map((q, index) => ({ ...q,
    question: translatedField(result, `q.${index}.question`, q.question),
    ...(q.header === undefined ? {} : { header: translatedField(result, `q.${index}.header`, q.header) }),
    ...(q.detail === undefined ? {} : { detail: translatedField(result, `q.${index}.detail`, q.detail) }),
    ...(q.options === undefined ? {} : { options: q.options.map((o, choice) => ({ ...o,
      label: translatedField(result, `q.${index}.o.${choice}.label`, o.label),
      ...(o.description === undefined ? {} : { description: translatedField(result, `q.${index}.o.${choice}.description`, o.description) }),
    })) }),
  }))
  const answers = history.answers.map((answer, index) => ({ ...answer,
    selected: answer.selected.map((text, choice) => translatedField(result, `a.${index}.s.${choice}`, text)),
    ...(answer.custom === undefined ? {} : { custom: translatedField(result, `a.${index}.custom`, answer.custom) }),
  }))
  const args = { ...history.args, questions }
  // `args` is DSH's lazy argument view with text()/complete(), not a JSON object.
  const call = { ...history.call, argsRaw: JSON.stringify(args) }
  return {
    answers,
    block: block.kind === undefined ? call : { ...block, call,
      ...(history.output === undefined ? {} : { content: [{ ...block.content[0], text: JSON.stringify({ ...history.output, answers }) }] }),
    },
  }
}

function parseRecord(text: unknown): Record<string, any> | undefined {
  if (typeof text !== 'string') return undefined
  try { const value: unknown = JSON.parse(text); return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined } catch { return undefined }
}
function isQuestion(value: any): value is TranslatableQuestion {
  return value !== null && typeof value === 'object' && typeof value.id === 'string' && typeof value.question === 'string'
    && (value.header === undefined || typeof value.header === 'string') && (value.detail === undefined || typeof value.detail === 'string')
    && (value.options === undefined || Array.isArray(value.options) && value.options.every((o: any) => o !== null && typeof o?.label === 'string' && (o.description === undefined || typeof o.description === 'string')))
}
function validAnswers(value: unknown): value is InteractionAnswer['answers'] {
  return Array.isArray(value) && value.every(a => a !== null && typeof a === 'object' && typeof a.id === 'string'
    && Array.isArray(a.selected) && a.selected.every((label: unknown) => typeof label === 'string') && (a.custom === undefined || typeof a.custom === 'string'))
}
