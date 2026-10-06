import type { spawn, spawnSync } from 'node:child_process'
import { AcpCliDriver, type AcpCliDriverOptions } from './acp-cli-driver.js'

export interface KiroCliDriverOptions {
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

/** Kiro CLI ACP v3；会话存储为嵌套目录，未验证前不声明本地会话探测。 */
export class KiroCliDriver extends AcpCliDriver {
  constructor(options: KiroCliDriverOptions = {}) {
    const base: AcpCliDriverOptions = {
      id: 'kiro-cli',
      name: 'Kiro CLI',
      binaries: options.binaries ?? ['kiro-cli'],
      args: ['acp', '--agent-engine', 'v3', '--auth-method', 'cli'],
      capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning', 'permission', 'questions'],
      ...(options.spawnSync === undefined ? {} : { spawnSync: options.spawnSync }),
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      probeReason: 'Kiro 会话存储为嵌套目录，尚未完成只读索引验证；未按 JSONL 规则猜测路径',
    }
    super(base)
  }
}
