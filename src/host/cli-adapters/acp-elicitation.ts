import type {
  CodingNsAgentQuestion,
  CodingNsAgentQuestionResponse,
} from '../../shared/contracts/cli-adapter.js'
import type { JsonRpcMessage } from './json-rpc-process.js'

/** ACP 表单提问与 DSH 原生问题之间的字段映射。 */
export interface AcpElicitationRequest {
  readonly requestId: string
  readonly rpcId: number | string
  readonly message: string
  readonly questions: readonly CodingNsAgentQuestion[]
  readonly bindings: readonly AcpElicitationBinding[]
}

export interface AcpElicitationBinding {
  readonly questionId: string
  readonly propertyKey: string
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'array'
  readonly multiSelect: boolean
  readonly optionValues: ReadonlyMap<string, unknown>
}

/** 客户端只声明 ACP form；URL 模式需要浏览器和独立的安全同意流程。 */
export const ACP_FORM_CLIENT_CAPABILITIES = {
  elicitation: { form: {} },
} as const

/** 解析 ACP 标准 `elicitation/create` 请求。 */
export function readAcpElicitationRequest(message: JsonRpcMessage): AcpElicitationRequest | null {
  if (message.method !== 'elicitation/create' || (typeof message.id !== 'string' && typeof message.id !== 'number')) return null
  const params = isRecord(message.params) ? message.params : null
  if (params === null || params.mode !== 'form' || !isRecord(params.requestedSchema)) return null
  const schema = params.requestedSchema
  const properties = isRecord(schema.properties) ? schema.properties : null
  if (properties === null) return null
  const messageText = typeof params.message === 'string' && params.message.trim() !== '' ? params.message.trim() : '请回答外部 Agent 的问题'
  const bindings: AcpElicitationBinding[] = []
  const questions: CodingNsAgentQuestion[] = []
  for (const [propertyKey, rawProperty] of Object.entries(properties)) {
    if (!isRecord(rawProperty)) continue
    const type = schemaType(rawProperty.type)
    if (type === null) continue
    const optionResult = schemaOptions(rawProperty)
    const title = stringValue(rawProperty.title) ?? propertyKey
    const detail = stringValue(rawProperty.description)
    const multiSelect = type === 'array'
    const question: CodingNsAgentQuestion = {
      id: propertyKey,
      question: messageText,
      ...(detail === undefined ? {} : { detail }),
      ...(title === messageText ? {} : { header: title }),
      ...(optionResult.options.length === 0 ? {} : { options: optionResult.options }),
      ...(multiSelect ? { multiSelect: true } : {}),
    }
    questions.push(question)
    bindings.push({
      questionId: propertyKey,
      propertyKey,
      type,
      multiSelect,
      optionValues: optionResult.values,
    })
  }
  if (questions.length === 0) return null
  return {
    requestId: String(message.id),
    rpcId: message.id,
    message: messageText,
    questions,
    bindings,
  }
}

/** 将 DSH 原生问题回答还原为 ACP form 的 `content` 对象。 */
export function acpElicitationResponse(
  request: AcpElicitationRequest,
  response: CodingNsAgentQuestionResponse,
): { readonly action: 'accept'; readonly content: Record<string, unknown> } {
  const content: Record<string, unknown> = {}
  for (const binding of request.bindings) {
    const answer = response.answers.find((item) => item.id === binding.questionId)
    if (answer === undefined) continue
    const selected = [...answer.selected]
    if (answer.custom?.trim()) selected.push(answer.custom.trim())
    if (selected.length === 0) continue
    const values = selected.map((value) => providerValue(value, binding))
    content[binding.propertyKey] = binding.multiSelect ? values : values[0]
  }
  return { action: 'accept', content }
}

/** ACP form 只允许扁平原子字段；未知类型交给上层安全降级。 */
function schemaType(value: unknown): AcpElicitationBinding['type'] | null {
  if (value === 'string' || value === 'number' || value === 'integer' || value === 'boolean') return value
  if (value === 'array') return 'array'
  if (Array.isArray(value)) {
    const primitive = value.find((item) => item === 'string' || item === 'number' || item === 'integer' || item === 'boolean')
    if (primitive === 'string' || primitive === 'number' || primitive === 'integer' || primitive === 'boolean') return primitive
  }
  return null
}

function schemaOptions(value: Record<string, unknown>): {
  readonly options: readonly { readonly label: string; readonly description?: string }[]
  readonly values: ReadonlyMap<string, unknown>
} {
  const values = new Map<string, unknown>()
  const options: Array<{ readonly label: string; readonly description?: string }> = []
  const enumValues = Array.isArray(value.enum)
    ? value.enum
    : isRecord(value.items) && Array.isArray(value.items.enum)
      ? value.items.enum
    : Array.isArray(value.oneOf)
      ? value.oneOf.flatMap((item) => isRecord(item) && 'const' in item ? [item] : [])
      : []
  for (const item of enumValues) {
    if (isRecord(item) && 'const' in item) {
      const raw = item.const
      const label = stringValue(item.title) ?? primitiveLabel(raw)
      if (label === undefined) continue
      const description = stringValue(item.description)
      options.push({ label, ...(description === undefined ? {} : { description }) })
      values.set(label, raw)
      continue
    }
    const label = primitiveLabel(item)
    if (label === undefined) continue
    options.push({ label })
    values.set(label, item)
  }
  return { options, values }
}

function providerValue(value: string, binding: AcpElicitationBinding): unknown {
  const mapped = binding.optionValues.get(value)
  if (mapped !== undefined || binding.optionValues.has(value)) return mapped
  if (binding.type === 'boolean') return value.trim().toLowerCase() === 'true'
  if (binding.type === 'number') {
    const number = Number(value)
    return Number.isFinite(number) ? number : value
  }
  if (binding.type === 'integer') {
    const number = Number.parseInt(value, 10)
    return Number.isFinite(number) ? number : value
  }
  return value
}

function primitiveLabel(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
