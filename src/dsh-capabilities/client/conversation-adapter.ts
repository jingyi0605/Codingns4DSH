export interface CodingNsConversationService {
  registerTemporaryNode?: (definition: unknown) => (() => void) | void
  register?: (definition: unknown) => (() => void) | void
}

/** 兼容不同版本的 Conversation 临时节点登记名。 */
export function registerConversationTemporaryNode(service: CodingNsConversationService, definition: unknown): () => void {
  const disposer = service.registerTemporaryNode?.(definition) ?? service.register?.(definition)
  return typeof disposer === 'function' ? disposer : () => undefined
}
