import type { spawn, spawnSync, SpawnSyncOptions } from 'node:child_process'
import type { CodingNsCliModelCatalog } from '../../shared/contracts/cli-adapter.js'
import type { CodingNsCliTurnInput } from '../../shared/contracts/cli-adapter.js'
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
      // Cursor CLI 在 SSH/TTY-less 的 stage0 子进程里会把 macOS 钥匙串预检误判为锁定。
      // CI 标记只关闭这层交互式预检，不携带或记录任何凭据；真正认证仍由 Cursor CLI 自己完成。
      environment: { CI: '1' },
      buildArgs: cursorAcpArgs,
      runtimeModelSelection: false,
      readModelCatalog: readCursorModelCatalog,
      capabilities: ['models', 'stream', 'resume', 'interrupt', 'tool-events', 'reasoning'],
      ...(options.spawnSync === undefined ? {} : { spawnSync: options.spawnSync }),
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      fallbackCatalog: cursorFallbackCatalog(),
      probeReason: 'Cursor ACP 未提供可安全读取的会话索引；未读取实验性的 store.db，也未用 resume 探测',
    }
    super(base)
  }
}

function cursorAcpArgs(input: CodingNsCliTurnInput): readonly string[] {
  const modelId = input.modelId?.trim()
  // Cursor ACP 不支持 session/set_model；必须在启动进程时传 --model。
  return modelId !== undefined && modelId !== '' && modelId !== 'provider-default'
    ? ['--model', modelId, 'acp']
    : ['acp']
}

function readCursorModelCatalog(command: string, runSpawnSync: typeof spawnSync): CodingNsCliModelCatalog | null {
  const result = runSpawnSync(command, ['--list-models'], {
    encoding: 'utf8', timeout: 15_000, windowsHide: true,
  } as SpawnSyncOptions & { encoding: 'utf8' })
  if (result.status !== 0) return null
  // 正常目录在 stdout；仅当旧版本把目录写到 stderr 时才回退读取 stderr，
  // 避免把认证/网络警告中形如「x - y」的日志行误识别成模型。
  const stdoutCatalog = parseCursorModelList(`${result.stdout ?? ''}`)
  if (stdoutCatalog.fallback !== true) return stdoutCatalog
  return parseCursorModelList(`${result.stderr ?? ''}`)
}

/**
 * 解析 `cursor-agent --list-models` 的公开文本目录。
 *
 * Cursor 会把可用的思考档位和 Fast 变体直接编码进 model id。这里保留完整
 * id，避免把 `claude-*-thinking-*` 等产品专用命名错误拆成 DSH 的 effort；
 * ACP 进程启动时会收到该完整 id，目录中的每一项都可以真实下发。
 */
export function parseCursorModelList(output: string): CodingNsCliModelCatalog {
  const models: Array<{ id: string; name: string; efforts: readonly string[] }> = []
  const seen = new Set<string>()
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine
      .replace(/\u001b\[[0-9;]*m/gu, '')
      .replace(/[\u200B-\u200D\uFEFF]/gu, '')
      .trim()
    const match = line.match(/^([^\s]+)\s+-\s+(.+)$/u)
    if (match === null) continue
    const id = match[1]!.trim()
    const name = match[2]!.trim()
    if (id === '' || name === '' || seen.has(id)) continue
    seen.add(id)
    models.push({ id, name, efforts: [] })
  }
  if (models.length === 0) return cursorFallbackCatalog()
  return {
    groups: [{ id: 'cursor', name: 'Cursor CLI', models }],
    currentModel: null,
    currentEffort: null,
  }
}

function cursorFallbackCatalog(): CodingNsCliModelCatalog {
  return {
    groups: [{
      id: 'cursor',
      name: 'Cursor CLI',
      models: [{ id: 'provider-default', name: '跟随 Cursor CLI 默认模型', efforts: [] }],
    }],
    currentModel: null,
    currentEffort: null,
    fallback: true,
  }
}
