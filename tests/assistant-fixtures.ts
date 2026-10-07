/** 测试只使用内存数据，避免回归读取或写入用户的助理状态目录。 */
export function memoryAssistantConversationStorage() {
  let value: unknown
  return { async read() { return value }, async write(next: unknown) { value = structuredClone(next) } }
}
