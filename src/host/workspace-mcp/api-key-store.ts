import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface WorkspaceMcpApiKeyStore {
  read(): Promise<string | null>
  write(key: string): Promise<void>
  clear(): Promise<void>
}

/** Stores the bearer key outside client-readable settings with owner-only file permissions. */
export class FileWorkspaceMcpApiKeyStore implements WorkspaceMcpApiKeyStore {
  constructor(private readonly filePath = defaultApiKeyPath()) {}

  async read(): Promise<string | null> {
    try {
      const key = (await readFile(this.filePath, 'utf8')).trim()
      return isWorkspaceMcpApiKey(key) ? key : null
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null
      throw error
    }
  }

  async write(key: string): Promise<void> {
    if (!isWorkspaceMcpApiKey(key)) throw new TypeError('Invalid Workspace MCP API key')
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${key}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, this.filePath)
    } finally {
      try { await unlink(temporary) } catch (error) { if (!isNodeError(error, 'ENOENT')) throw error }
    }
  }

  async clear(): Promise<void> {
    try {
      await (await import('node:fs/promises')).unlink(this.filePath)
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }
}

export function generateWorkspaceMcpApiKey(): string {
  return randomBytes(32).toString('base64url')
}

export function isWorkspaceMcpApiKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value)
}

function defaultApiKeyPath(): string {
  const configured = process.env.CODINGNS4DSH_STATE_DIR?.trim()
  const stateDirectory = configured || join(homedir(), '.config', 'codingns4dsh')
  return join(stateDirectory, 'workspace-mcp-api-key')
}

function isNodeError(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && (error as { code?: unknown }).code === code
}
