/** Read-only listing contract shared with the native Host workspace file browser. */
export interface WorkspaceDirectoryBrowser {
  list(root: string, path: string, signal: AbortSignal): Promise<{
    entries: readonly { name: string; type: string }[]
    truncated: boolean
  }>
}

interface NativeWorkspaceFiles {
  // The pinned list implementation consumes only workspaceRoot from its resolved scope.
  list(scope: { workspaceRoot: string }, path: string, signal: AbortSignal): ReturnType<WorkspaceDirectoryBrowser['list']>
}

export function supportsWorkspaceDirectory(context: unknown): boolean {
  return typeof readWorkspaceFiles(context)?.list === 'function'
}

export function createWorkspaceDirectoryBrowser(context: unknown): WorkspaceDirectoryBrowser {
  return { async list(workspaceRoot, path, signal) {
    signal.throwIfAborted()
    // Resolve at execution time so a disposed or replaced provider is never retained.
    const native = readWorkspaceFiles(context)
    if (typeof native?.list !== 'function') throw Object.assign(new Error('The native Host file browser is unavailable.'), { code: 'QUICK_APP_BROWSE_UNAVAILABLE' })
    return native.list({ workspaceRoot }, path || '.', signal)
  } }
}

function readWorkspaceFiles(context: unknown): NativeWorkspaceFiles | undefined {
  const ctx = context as { get?(name: string): unknown; workspaceFiles?: NativeWorkspaceFiles } | undefined
  try {
    // Cordis rejects direct access to services outside the consumer's injection chain.
    return (typeof ctx?.get === 'function' ? ctx.get('workspaceFiles') : ctx?.workspaceFiles) as NativeWorkspaceFiles | undefined
  } catch { return undefined }
}
