import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeCustomCommand } from './magpie-detection.js'

export interface MagpieCommandStore {
  read(): Promise<string | null>
  write(command: string | null): Promise<void>
}

/** Host-local state, never exported through settings or copied to PeerHosts. */
export class FileMagpieCommandStore implements MagpieCommandStore {
  constructor(private readonly filePath = join(
    process.env.CODINGNS4DSH_STATE_DIR?.trim() || join(homedir(), '.config', 'codingns4dsh'),
    'magpie-command',
  )) {}

  async read(): Promise<string | null> {
    try {
      return normalizeCustomCommand(await readFile(this.filePath, 'utf8'))
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async write(command: string | null): Promise<void> {
    if (command === null) {
      try { await unlink(this.filePath) } catch (error) { if (!isMissing(error)) throw error }
      return
    }
    const normalized = normalizeCustomCommand(command)
    if (normalized === null) throw new TypeError('Invalid Magpie executable path')
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${normalized}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporary, this.filePath)
    } finally {
      try { await unlink(temporary) } catch (error) { if (!isMissing(error)) throw error }
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
