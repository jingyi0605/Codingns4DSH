import type { CodingNsCliAdapterId } from '../../shared/contracts/cli-adapter.js'
import type { Context } from '@deepseek-ai/cordis'

/**
 * DSH LLM 运行时的最小结构。
 *
 * 外部 CLI 仍然由 `llm/stream` 事件接管，这里只声明 DSH 在 prompt admission
 * 阶段需要的 Provider 和模型能力，避免业务层直接依赖 DSH 版本专属类型。
 */
interface DshVirtualLlmRuntime {
  registerAdapter(
    providers: string[],
    adapter: DshVirtualLlmAdapter,
  ): DshVirtualAdapterRegistration
}

interface DshVirtualAdapterRegistration {
  (): void
  replace?(providers: string[]): void
}

interface DshVirtualLlmAdapter {
  providerInfo(provider: string): { readonly id: string; readonly name: string }
  /** DSH 0.2 在注册路由时会读取该策略；未声明时使用 DSH 默认策略。 */
  providerRetryPolicy(provider: string): undefined
  /** 外部 Agent 的图片计费由其自身用量事件提供，虚拟 Provider 不声明价格。 */
  imageRequestPricing(provider: string, model: string): undefined
  listModels(provider: string): Promise<readonly unknown[]>
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<DshVirtualModelInfo>
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{
    readonly model: DshVirtualModelInfo
    readonly stream: (options: unknown) => AsyncIterable<never>
  }>
  stream(options: unknown): AsyncIterable<never>
}

interface DshVirtualModelInfo {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly inputModalities: readonly ['text', 'image']
}

interface DshVirtualProviderRegistration {
  setProviders(providers: readonly CodingNsCliAdapterId[]): void
  dispose(): void
}

/**
 * 注册外部 CLI 的虚拟 DSH Provider。
 *
 * `resolveModel` 是这里唯一有业务含义的方法：外部 CLI 适配器支持文本和图片。
 * `stream` 理论上不会被调用，因为 Feature 已在 `llm/stream` waterfall 中短路；
 * 若路由失配，主动抛错比静默返回空流更容易定位问题。
 */
export function createDshVirtualProviderRegistration(
  dshContext: Context | undefined,
): DshVirtualProviderRegistration | undefined {
  const llm = readLlmRuntime(dshContext)
  if (llm === undefined) return undefined

  const adapter: DshVirtualLlmAdapter = {
    providerInfo: (provider) => ({ id: provider, name: `CodingNS ${provider}` }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async () => [],
    resolveModel: async (provider, model, signal) => {
      signal?.throwIfAborted()
      return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
    },
    prepareCall: async (provider, model, signal) => ({
      model: await adapter.resolveModel(provider, model, signal),
      stream: (options) => adapter.stream(options),
    }),
    async *stream() {
      throw new Error('CODINGNS_EXTERNAL_PROVIDER_STREAM_NOT_INTERCEPTED')
    },
  }

  let registration: DshVirtualAdapterRegistration | undefined
  let currentProviders: string[] = []

  const setProviders = (providers: readonly CodingNsCliAdapterId[]): void => {
    const nextProviders = [...new Set(providers.filter((provider) => provider.trim() !== ''))]
    if (sameProviders(currentProviders, nextProviders)) return

    if (registration?.replace !== undefined) {
      registration.replace(nextProviders)
      currentProviders = nextProviders
      return
    }

    registration?.()
    registration = undefined
    currentProviders = []
    if (nextProviders.length === 0) return

    registration = llm.registerAdapter(nextProviders, adapter)
    currentProviders = nextProviders
  }

  return {
    setProviders,
    dispose: () => {
      registration?.()
      registration = undefined
      currentProviders = []
    },
  }
}

function readLlmRuntime(dshContext: Context | undefined): DshVirtualLlmRuntime | undefined {
  if (dshContext === undefined) return undefined
  try {
    const candidate = dshContext.get('llm') as Record<string, unknown> | undefined
    if (candidate === undefined || typeof candidate.registerAdapter !== 'function') return undefined
    return candidate as unknown as DshVirtualLlmRuntime
  } catch {
    return undefined
  }
}

function sameProviders(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((provider, index) => provider === right[index])
}
