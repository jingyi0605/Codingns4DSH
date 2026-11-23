import type { CodingNsCliMessage } from '../../shared/contracts/cli-adapter.js'

function sourceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Match the Host control identity, not the visible text a human can also send. */
export function isInjectedStepNotice(message: CodingNsCliMessage): boolean {
  if (message.role !== 'user' || !sourceRecord(message.source) || message.source.form !== 'notice') return false
  return message.source.kind === 'model-selection' && message.id?.startsWith('codingns-external-step-') === true
    || message.source.kind === 'plugin' && message.source.plugin === 'codingns4dsh'
}

export function isHumanUserMessage(message: CodingNsCliMessage): boolean {
  if (message.role !== 'user') return false
  if (message.source === undefined) return true
  return sourceRecord(message.source) && (message.source.kind === undefined || message.source.kind === 'user')
}

/** Later context injections cannot replace a notice; a new human message can. */
export function hasNativeStepNoticeInput(messages: readonly CodingNsCliMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (isInjectedStepNotice(message)) return true
    if (isHumanUserMessage(message)) return false
  }
  return false
}
