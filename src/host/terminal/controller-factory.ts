import type { Context } from '@deepseek-ai/cordis'
import type { TerminalEnhancementSettings } from '../../shared/contracts/config.js'
import { ConptyTerminalBackend } from './backends/conpty-backend.js'
import { LocalPtyTerminalBackend } from './backends/local-pty-backend.js'
import { detectTmuxPath, TmuxTerminalBackend } from './backends/tmux-backend.js'
import type { CodingNsTerminalRuntimeType } from '../../shared/contracts/terminal.js'
import { CodingNsTerminalController, type DshTerminalAgent } from './terminal-controller.js'
import type { TerminalShellProfileId } from './shell-detection.js'
import type { TerminalRuntimeAdapter } from './runtime-adapter.js'
import { TerminalRuntimeManager } from './runtime-manager.js'
import { CodingNsTerminalService } from './terminal-service.js'
import {
  CodingNsTerminalStore,
  InMemoryTerminalStorePersistence,
  JsonFileTerminalStorePersistence,
} from './terminal-store.js'
import {
  InMemoryTerminalProcessStorePersistence,
  JsonFileTerminalProcessStorePersistence,
  TerminalProcessStore,
} from './terminal-process-store.js'
import { TerminalProcessService } from './terminal-process-service.js'

interface TerminalControllerFactoryCommonOptions {
  readonly settings: () => TerminalEnhancementSettings
  readonly platform?: string
  readonly generation?: (agent: DshTerminalAgent, attachmentId: string) => string
  readonly workspaceId?: (agent: DshTerminalAgent, cwd: string) => string
  readonly workingDirectory?: (agent: DshTerminalAgent) => string | undefined
  readonly registerWorkspaceRoot?: (workspaceId: string, cwd: string) => void
  readonly resolveWorkspaceRoot?: (workspaceId: string) => string | null
}

export type TerminalControllerFactoryOptions = TerminalControllerFactoryCommonOptions & (
  | {
    readonly enhancedEnabled: false
    readonly baselineBackend?: TerminalRuntimeAdapter
  }
  | {
    readonly enhancedEnabled: true
    readonly hostId: string
    readonly storeFilename: string
    readonly processStoreFilename?: string
  }
)

export interface TerminalControllerFactoryResult {
  readonly mode: 'baseline' | 'enhanced'
  readonly runtimeTypes: readonly CodingNsTerminalRuntimeType[]
  readonly runtimeWarning?: string
  readonly controller: CodingNsTerminalController
  readonly service: CodingNsTerminalService
  readonly processService: TerminalProcessService
}

/**
 * 启动时一次性选择 controller 模式。
 *
 * 开关写入只影响下一次调用；当前进程绝不热切同名 Cordis 服务。两个模式共用
 * 插件自有 controller，区别只在 backend 和 store 的生命周期。
 */
export async function createTerminalController(
  ctx: Context,
  options: TerminalControllerFactoryOptions,
): Promise<TerminalControllerFactoryResult> {
  const platform = options.platform ?? process.platform
  if (!options.enhancedEnabled) {
    const localBackend = options.baselineBackend ?? new LocalPtyTerminalBackend({ platform })
    const tmuxPath = platform === 'darwin' || platform === 'linux' ? detectTmuxPath(platform) : null
    const tmuxBackend = tmuxPath === null || localBackend.runtimeTypes.includes('tmux')
      ? undefined
      : new TmuxTerminalBackend({ platform, tmuxPath })
    const backends = tmuxBackend === undefined ? [localBackend] : [localBackend, tmuxBackend]
    return assembleController(ctx, {
      mode: 'baseline',
      hostId: 'local-baseline',
      store: new CodingNsTerminalStore(new InMemoryTerminalStorePersistence()),
      backends,
      runtimeTypes: backends.flatMap((backend) => backend.runtimeTypes),
      ...(tmuxBackend === undefined && !localBackend.runtimeTypes.includes('tmux') && (platform === 'darwin' || platform === 'linux')
        ? { runtimeWarning: '未检测到可执行的 tmux，调试终端将回退到 local-pty。' }
        : {}),
      processStore: new TerminalProcessStore(new InMemoryTerminalProcessStorePersistence()),
      settings: options.settings,
      platform,
      runtimeType: () => 'local-pty',
      ...(options.generation === undefined ? {} : { generation: options.generation }),
      ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
      ...(options.workingDirectory === undefined ? {} : { workingDirectory: options.workingDirectory }),
      ...(options.resolveWorkspaceRoot === undefined ? {} : { resolveWorkspaceRoot: options.resolveWorkspaceRoot }),
    })
  }

  const localBackend = new LocalPtyTerminalBackend({ platform })
  const tmuxPath = platform === 'darwin' || platform === 'linux' ? detectTmuxPath(platform) : null
  const enhancedBackend = platform === 'win32'
    ? new ConptyTerminalBackend({ platform })
    : tmuxPath === null ? localBackend : new TmuxTerminalBackend({ platform, tmuxPath })
  const runtimeTypes = [...enhancedBackend.runtimeTypes]
  return assembleController(ctx, {
    mode: 'enhanced',
    hostId: options.hostId,
    store: new CodingNsTerminalStore(new JsonFileTerminalStorePersistence(options.storeFilename)),
    processStore: new TerminalProcessStore(new JsonFileTerminalProcessStorePersistence(options.processStoreFilename ?? `${options.storeFilename}.processes`)),
    backends: [enhancedBackend],
    runtimeTypes,
    ...(enhancedBackend === localBackend ? { runtimeWarning: '未检测到可执行的 tmux，终端已回退到 local-pty。' } : {}),
    ...(enhancedBackend === localBackend ? { runtimeType: () => 'local-pty' as const } : {}),
    settings: options.settings,
    platform,
    ...(options.generation === undefined ? {} : { generation: options.generation }),
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.registerWorkspaceRoot === undefined ? {} : { registerWorkspaceRoot: options.registerWorkspaceRoot }),
    ...(options.workingDirectory === undefined ? {} : { workingDirectory: options.workingDirectory }),
    ...(options.resolveWorkspaceRoot === undefined ? {} : { resolveWorkspaceRoot: options.resolveWorkspaceRoot }),
  })
}

interface AssembleControllerOptions extends TerminalControllerFactoryCommonOptions {
  readonly mode: 'baseline' | 'enhanced'
  readonly hostId: string
  readonly store: CodingNsTerminalStore
  readonly backends: readonly TerminalRuntimeAdapter[]
  readonly runtimeTypes: readonly CodingNsTerminalRuntimeType[]
  readonly runtimeWarning?: string
  readonly runtimeType?: (profileId: Exclude<TerminalShellProfileId, 'system'>, platform: string) => CodingNsTerminalRuntimeType
  readonly processStore: TerminalProcessStore
  readonly resolveWorkspaceRoot?: (workspaceId: string) => string | null
}

async function assembleController(
  ctx: Context,
  options: AssembleControllerOptions,
): Promise<TerminalControllerFactoryResult> {
  const service = new CodingNsTerminalService(options.store, new TerminalRuntimeManager(options.backends))
  await service.initialize()
  if (options.mode === 'enhanced') await service.recover()
  const controller = new CodingNsTerminalController(ctx, {
    hostId: options.hostId,
    service,
    settings: options.settings,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.generation === undefined ? {} : { generation: options.generation }),
    ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
    ...(options.registerWorkspaceRoot === undefined ? {} : { registerWorkspaceRoot: options.registerWorkspaceRoot }),
    ...(options.workingDirectory === undefined ? {} : { workingDirectory: options.workingDirectory }),
    ...(options.runtimeType === undefined ? {} : { runtimeType: options.runtimeType }),
  })
  const processService = new TerminalProcessService(options.processStore, {
    hostId: options.hostId,
    terminalService: service,
    resolveWorkspaceRoot: options.resolveWorkspaceRoot ?? ((workspaceId) => workspaceId),
  })
  await processService.initialize()
  if (options.mode === 'enhanced') await processService.recover()
  ctx.effect(
    () => () => service.dispose(),
    options.mode === 'baseline'
      ? 'codingns4dsh: 本机 PTY 与终端 attach 清理'
      : 'codingns4dsh: 持久终端 attach 清理',
  )
  return {
    mode: options.mode,
    runtimeTypes: options.runtimeTypes,
    ...(options.runtimeWarning === undefined ? {} : { runtimeWarning: options.runtimeWarning }),
    controller,
    service,
    processService,
  }
}
