import type { spawn, spawnSync } from 'node:child_process'
import type { CodingNsCliModelCatalog } from '../../shared/contracts/cli-adapter.js'
import { AcpCliDriver, type AcpCliDriverOptions } from './acp-cli-driver.js'

export interface CursorCliDriverOptions {
  readonly binaries?: readonly string[]
  readonly spawnSync?: typeof spawnSync
  readonly spawn?: typeof spawn
}

/** Cursor CLI 的实验性 ACP 路径；不声明 Usage、Fork、回滚、压缩或权限交互。 */
export class CursorCliDriver extends AcpCliDriver {
  constructor(options: CursorCliDriverOptions = {}) {
    const base: AcpCliDriverOptions = {
      id: 'cursor-cli',
      name: 'Cursor CLI',
      binaries: options.binaries ?? ['cursor-agent', 'agent'],
      args: ['acp'],
      capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning'],
      ...(options.spawnSync === undefined ? {} : { spawnSync: options.spawnSync }),
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      fallbackCatalog: emptyCursorCatalog(),
      probeReason: 'Cursor ACP 未提供可安全读取的会话索引；未读取实验性的 store.db，也未用 resume 探测',
    }
    super(base)
  }
}

function emptyCursorCatalog(): CodingNsCliModelCatalog { return { groups: [], currentModel: null, currentEffort: null } }
