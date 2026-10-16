/** Request-scoped CRUD ordering, shared by local apps, remote apps and the legacy preview. */
const mutations = new Map<string, Promise<unknown>>()

export async function serializeWorkspaceMutation<T>(physicalPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutations.get(physicalPath) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  mutations.set(physicalPath, next)
  try { return await next } finally { if (mutations.get(physicalPath) === next) mutations.delete(physicalPath) }
}
