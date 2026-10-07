import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface AssistantConversationStorage {
  read(): Promise<unknown>
  write(value: unknown): Promise<void>
}

/** 只保存 CodingNS 自有助理数据，绝不读取或修改 DSH 项目会话。 */
export function assistantConversationDirectory(): string {
  return process.env.CODINGNS4DSH_STATE_DIR?.trim() || join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'codingns4dsh')
}

export function createAssistantConversationStorage(directory = assistantConversationDirectory()): AssistantConversationStorage {
  const path = join(directory, 'assistant-conversation.json')
  return {
    async read() {
      try {
        const text = await readFile(path, 'utf8')
        if (text.length > 4_000_000) throw new Error('助理对话记录过大，请检查存储文件')
        return JSON.parse(text)
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    },
    async write(value) {
      await mkdir(directory, { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await rename(temporary, path) }
      finally { await rm(temporary, { force: true }) }
    },
  }
}
