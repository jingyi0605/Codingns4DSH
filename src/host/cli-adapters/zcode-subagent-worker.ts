import { parentPort, workerData } from 'node:worker_threads'
import { readZcodeSubagentDetail, readZcodeSubagents } from './zcode-subagent.js'

// DatabaseSync 是同步 API，刻意隔离在 worker 线程里，避免阻塞会话与 RPC 事件循环。
try {
  parentPort?.postMessage({
    value: workerData.agentId === undefined
      ? readZcodeSubagents(workerData.databasePath, workerData.ids)
      : readZcodeSubagentDetail(workerData.databasePath, workerData.ids, workerData.agentId, workerData.cursor === undefined ? {} : { cursor: workerData.cursor }),
  })
} catch (error) {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
}
