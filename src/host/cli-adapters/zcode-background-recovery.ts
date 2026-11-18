import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'

export interface ZcodeRecoveredReply {
  readonly turnId: string
  readonly messageId: string
  readonly text: string
}

/** Read only completed parent replies to native workflow terminal notifications. */
export function readZcodeBackgroundReplies(path: string, providerId: string, since: number): ZcodeRecoveredReply[] {
  if (!existsSync(path)) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN')
    if (db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('message','part')").get()?.n !== 2) return []
    const rows = db.prepare(`SELECT a.id, json_extract(a.data,'$.anchor.turnId') turn_id FROM message a
      JOIN message n ON n.id=json_extract(a.data,'$.parentID') AND n.session_id=a.session_id
      WHERE a.session_id=? AND a.time_created>=? AND json_extract(a.data,'$.role')='assistant'
      AND json_extract(a.data,'$.time.completed') IS NOT NULL
      AND json_extract(n.data,'$.metadata.originMeta.backgroundSource')='workflow'
      AND json_extract(n.data,'$.metadata.originMeta.workflowNotification.kind')='terminal'
      ORDER BY a.time_created LIMIT 201`).all(providerId, since)
    if (rows.length > 200) throw new Error('ZCode 后台历史超过自动恢复上限，请先分批查看原生历史')
    return rows.flatMap(row => {
      if (typeof row.id !== 'string') return []
      const parts = db.prepare("SELECT json_extract(data,'$.text') text FROM part WHERE session_id=? AND message_id=? AND json_extract(data,'$.type')='text' ORDER BY time_created,id").all(providerId, row.id)
      const text = parts.map(p => typeof p.text === 'string' ? p.text : '').join('')
      return text ? [{ turnId: typeof row.turn_id === 'string' ? row.turn_id : `message-${row.id}`, messageId: row.id, text }] : []
    })
  } finally { db.close() }
}

export function recoverZcodeBackgroundReplies(path: string, providerId: string, since: number): Promise<ZcodeRecoveredReply[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./zcode-background-recovery-worker.js', import.meta.url), { workerData: { path, providerId, since } })
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('ZCode background recovery timed out')) }, 5000)
    worker.once('message', (m: { replies?: ZcodeRecoveredReply[]; error?: string }) => m.error ? reject(new Error(m.error)) : resolve(m.replies ?? []))
    worker.once('error', reject)
    worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`ZCode recovery worker exited (${code})`)) })
  })
}
