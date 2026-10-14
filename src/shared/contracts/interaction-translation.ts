import type { SessionTranslationFailure, SessionTranslationRecord } from './session-translation.js'

/** Text is translated independently; keys and interaction data never reach the model. */
export interface InteractionTranslationField {
  readonly key: string
  readonly text: string
}

export interface InteractionTranslationResult {
  readonly enabled: boolean
  readonly records: Readonly<Record<string, SessionTranslationRecord>>
  readonly diagnostics?: Readonly<Record<string, InteractionTranslationDiagnostic>>
}

export interface InteractionTranslationDiagnostic {
  readonly attempts: number
  readonly queueMs: number
  readonly executionMs: number
  readonly phase: 'queue' | 'translation' | 'retry' | 'complete'
  readonly cacheHit: boolean
  readonly failure?: SessionTranslationFailure
}

export interface TranslatableQuestion {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
  readonly intent?: { readonly kind: string; readonly approve: string; readonly callId?: string }
}

export interface InteractionAnswer {
  readonly answers: readonly {
    readonly id: string
    readonly selected: readonly string[]
    readonly custom?: string
  }[]
}

export function questionTranslationFields(questions: readonly TranslatableQuestion[]): InteractionTranslationField[] {
  const fields: InteractionTranslationField[] = []
  const add = (key: string, text: string | undefined): void => {
    if (text !== undefined && text.trim() !== '') fields.push({ key, text })
  }
  questions.forEach((question, index) => {
    for (const name of ['question', 'header', 'detail'] as const) add(`q.${index}.${name}`, question[name])
    question.options?.forEach((option, optionIndex) => {
      add(`q.${index}.o.${optionIndex}.label`, option.label)
      add(`q.${index}.o.${optionIndex}.description`, option.description)
    })
  })
  return fields
}

export function answerTranslationFields(answer: InteractionAnswer): InteractionTranslationField[] {
  return answer.answers.flatMap((item, index) => item.custom?.trim()
    ? [{ key: `a.${index}.custom`, text: item.custom }]
    : [])
}

/** Only free text changes on submission. Option values and question IDs stay verbatim. */
export function translatedAnswer(answer: InteractionAnswer, result: InteractionTranslationResult): InteractionAnswer {
  return { ...answer, answers: answer.answers.map((item, index) => {
    const record = result.records[`a.${index}.custom`]
    return result.enabled && record !== undefined && record.original === item.custom && !record.failed
      ? { ...item, custom: record.translated }
      : item
  }) }
}

export function translatedField(result: InteractionTranslationResult | undefined, key: string, original: string): string {
  const record = result?.records[key]
  return result?.enabled && record !== undefined && record.original === original && !record.failed ? record.translated : original
}

/** Approval is determined by the original intent, never by translated labels or position. */
export function planApproval(questions: readonly TranslatableQuestion[]): { question: TranslatableQuestion; option: number } | undefined {
  const question = questions[0]
  if (questions.length !== 1 || question?.intent?.kind !== 'plan-review' || question.detail === undefined
    || question.multiSelect || (question.options?.length ?? 0) > 2) return undefined
  const option = question.options?.findIndex(item => item.label === question.intent!.approve) ?? -1
  return option < 0 ? undefined : { question, option }
}
