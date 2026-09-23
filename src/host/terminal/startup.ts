import type { Context } from '@deepseek-ai/cordis'
import type { SettingsProvider, SettingsScope } from '@deepseek-ai/dsh-settings'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { CodingNsSettings } from '../../shared/contracts/config.js'
import {
  createTerminalController,
  type TerminalControllerFactoryResult,
} from './controller-factory.js'
import { terminalStorePath } from './terminal-store.js'

const HOST_ID_FILENAME = 'host-id'
const HOST_ID_PATTERN = /^local-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export interface TerminalStartupIdentity {
  readonly hostId: string
  readonly storeFilename: string
  readonly hostIdFilename: string
}

export interface InstallTerminalControllerOptions {
  readonly platform?: string
  readonly createController?: typeof createTerminalController
  readonly resolveIdentity?: (settingsDocumentPath: string) => Promise<TerminalStartupIdentity>
  /** 由 Host 解析稳定 Workspace ID 到受信任根目录；不能接收浏览器传来的绝对路径。 */
  readonly resolveWorkspaceRoot?: (workspaceId: string) => string | null
}

/**
 * 从 DSH 设置文档旁边的持久目录读取本机终端身份。
 *
 * hostId 首次生成后独占写入，不依赖 PID、端口或 Bundle 安装路径；同一 Profile
 * 重启后会继续使用同一身份和同一终端映射文件。
 */
export async function resolveTerminalStartupIdentity(
  settingsDocumentPath: string,
  createId: () => string = () => `local-${randomUUID()}`,
): Promise<TerminalStartupIdentity> {
  if (settingsDocumentPath.trim() === '') throw new Error('DSH 设置文档路径为空，无法定位终端持久目录')
  const absoluteSettingsPath = absolutePath(settingsDocumentPath)
  const hostIdFilename = join(dirname(absoluteSettingsPath), 'dsh-codingns', HOST_ID_FILENAME)
  await mkdir(dirname(hostIdFilename), { recursive: true, mode: 0o700 })

  let hostId: string
  try {
    hostId = parseHostId(await readFile(hostIdFilename, 'utf8'), hostIdFilename)
  } catch (error) {
    if (!isMissingFile(error)) throw error
    const candidate = parseHostId(createId(), '新生成的 Host ID')
    try {
      await writeFile(hostIdFilename, `${candidate}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      hostId = candidate
    } catch (writeError) {
      if (!isExistingFile(writeError)) throw writeError
      hostId = parseHostId(await readFile(hostIdFilename, 'utf8'), hostIdFilename)
    }
  }

  return {
    hostId,
    storeFilename: terminalStorePath(absoluteSettingsPath),
    hostIdFilename,
  }
}

/** 每个浏览器 attachment 都是一个短命 generation，不能写入持久记录。 */
export function terminalAttachmentGeneration(hostId: string, attachmentId: string): string {
  return `${hostId}:terminal-attach:${attachmentId}`
}

/** 工作区身份使用规范化绝对路径，避免同一路径的相对写法生成两份映射。 */
export function terminalWorkspaceId(cwd: string): string {
  return absolutePath(cwd)
}

/**
 * 在 Host 启动时读取一次启用快照并安装唯一 controller。
 * 设置后续变化不会热切同名 Cordis service，必须重启 DSH 才会重新选择模式。
 */
export async function installTerminalController(
  ctx: Context,
  settings: SettingsScope<CodingNsSettings>,
  provider: Pick<SettingsProvider, 'documentPath'>,
  options: InstallTerminalControllerOptions = {},
): Promise<TerminalControllerFactoryResult> {
  const createController = options.createController ?? createTerminalController
  const current = settings.get()
  const enhancedEnabled = current.modules.terminalEnhancement ?? false
  const common = {
    settings: () => settings.get().terminalEnhancement,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.resolveWorkspaceRoot === undefined ? {} : { resolveWorkspaceRoot: options.resolveWorkspaceRoot }),
  }

  if (!enhancedEnabled) {
    return createController(ctx, { enhancedEnabled: false, ...common })
  }

  const documentPath = provider.documentPath
  if (documentPath === undefined) {
    throw new Error('终端强化需要文件型 DSH 设置 Provider，以便持久保存 Host ID 和终端映射')
  }
  const identity = await (options.resolveIdentity ?? resolveTerminalStartupIdentity)(documentPath)
  return createController(ctx, {
    enhancedEnabled: true,
    hostId: identity.hostId,
    storeFilename: identity.storeFilename,
    generation: (_agent, attachmentId) => terminalAttachmentGeneration(identity.hostId, attachmentId),
    workspaceId: (_agent, cwd) => terminalWorkspaceId(cwd),
    ...common,
  })
}

function parseHostId(value: string, source: string): string {
  const normalized = value.trim().toLowerCase()
  if (!HOST_ID_PATTERN.test(normalized)) throw new Error(`${source} 包含无效的终端 Host ID`)
  return normalized
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT'
}

function isExistingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST'
}

function isNodeError(error: unknown): error is Error & { readonly code?: string } {
  return error instanceof Error
}

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : join(process.cwd(), path)
}
