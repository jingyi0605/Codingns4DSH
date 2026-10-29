export interface NativeLlmModel {
  readonly provider: string
  readonly model: string
  readonly label: string
}

export interface NativeLlmCatalog {
  readonly models: readonly NativeLlmModel[]
  readonly default: NativeLlmModel | null
  readonly errors: readonly string[]
}

export interface NativeLlmPromptMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

export interface NativeLlmCompletionOptions {
  readonly reasoningEffort?: string
}
