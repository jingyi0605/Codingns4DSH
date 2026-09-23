import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsTerminalStatus } from '../../shared/contracts/terminal.js'
import {
  detectTerminalShells,
  resolveTerminalShell,
  type DetectedTerminalShell,
} from '../terminal/shell-detection.js'
import { CodingNsRpcError } from '../rpc-table.js'
import type { CodingNsHostServices } from './types.js'

export interface TerminalStatusFeatureOptions {
  readonly platform?: string
  readonly controllerMode?: CodingNsTerminalStatus['controllerMode']
  readonly effectiveEnabled?: boolean
  readonly detectShells?: () => readonly DetectedTerminalShell[]
}

/**
 * 向设置页报告 Host 的真实平台能力和当前 controller 模式。
 *
 * 基线与强化模式都由插件自有 controller 提供 webTerminals；该状态描述的是
 * 当前进程实际采用的 backend，不能用设置里下次启动的目标值冒充生效状态。
 */
export function createTerminalStatusFeature(options: TerminalStatusFeatureOptions = {}): FeatureModule<CodingNsHostServices> {
  const platform = options.platform ?? process.platform
  const controllerMode = options.controllerMode ?? 'baseline'
  const effectiveEnabled = options.effectiveEnabled ?? controllerMode === 'enhanced'
  const detectShells = options.detectShells ?? (() => detectTerminalShells({ platform }))

  return {
    descriptor: {
      name: 'terminalStatus',
      version: '0.1.0',
      enabledByDefault: true,
      dependencies: [],
      runtime: 'host',
    },
    start(context) {
      context.resources.add(context.services.rpc.register('terminal', (action) => {
        if (action !== 'status') {
          throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知 CodingNS RPC: terminal/${action}`)
        }
        const shells = detectShells()
        const requested = context.services.settings?.get().terminalEnhancement.defaultProfile ?? 'system'
        const available = shells.filter(
          (shell): shell is DetectedTerminalShell & { path: string } => shell.available && shell.path !== null,
        )
        let resolved: ReturnType<typeof resolveTerminalShell> | null = null
        try {
          resolved = resolveTerminalShell(requested, shells, platform)
        } catch {
          // 没有可用 shell 时仍返回诊断快照，让设置页能明确显示空列表。
        }
        return {
          platform: normalizePlatform(platform),
          controllerMode,
          effectiveEnabled,
          profiles: available.map((shell) => ({
            profileId: shell.profileId,
            name: shell.displayName,
            path: shell.path,
          })),
          resolvedProfileId: resolved?.resolvedProfileId ?? null,
          ...(resolved?.fallbackReason === undefined ? {} : { fallbackReason: resolved.fallbackReason }),
        } satisfies CodingNsTerminalStatus
      }))
    },
  }
}

function normalizePlatform(platform: string): CodingNsTerminalStatus['platform'] {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : 'unsupported'
}
