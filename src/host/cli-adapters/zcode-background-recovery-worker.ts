import { parentPort, workerData } from 'node:worker_threads'
import { readZcodeBackgroundReplies } from './zcode-background-recovery.js'
try { parentPort?.postMessage({ replies: readZcodeBackgroundReplies(workerData.path, workerData.providerId, workerData.since) }) }
catch (e) { parentPort?.postMessage({ error: e instanceof Error ? e.message : String(e) }) }
