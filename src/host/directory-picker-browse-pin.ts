import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * 把工作区目录选择固定在网页内目录浏览框上。
 *
 * 官方 `directory-picker-auto` 在本机会挂载原生选择器，插件的 Bundle 补丁把它关闭后，
 * 由本入口挂载官方浏览后端。冷启动时原生选择器从未出现，两者没有交集；但在热更新、
 * 热启用里，补丁生效前原生选择器可能已经占着 `directoryPicker`，此时直接启动浏览后端
 * 会报 `service "directoryPicker" has been registered at <NativeDirectoryPicker>`，
 * 官方插件管理器把这次启用判为失败，并把刚装好的新版和回滚的旧版一并卸掉。
 *
 * 因此浏览后端必须由本入口在确认服务已空闲后再挂载：先等原生选择器自然退出，超过
 * 宽限期仍占着就主动移除它，再挂载。已经是浏览后端时什么都不做；清不掉时抛出带有
 * 占用者名称的错误，不再只留下一句“已被注册”。
 * @module codingns4dsh/directory-picker-pin
 */

/** Cordis 插件名。 */
export const name = 'codingns4dsh-directory-picker-browse'
/** 需要 Loader 才能像官方自适应选择器一样把后端挂成 Loader 条目。 */
export const inject = ['loader']

const BROWSE_BACKEND = '@deepseek-ai/dsh-host-directory-picker-browse'
const SERVICE_NAME = 'directoryPicker'

/** 空闲检查间隔。 */
export const POLL_INTERVAL_MS = 50
/** 给原生选择器自然退出的时间，超过后才主动移除。 */
export const GRACE_MS = 2_000
/** 移除后仍占着服务时放弃并报错的总时限。 */
export const DEADLINE_MS = 8_000

/** 占用 `directoryPicker` 服务的实例中本入口会用到的部分。 */
interface PickerHolder {
  capability?: () => { kind?: unknown } | undefined
  ctx?: { fiber?: { dispose?: () => Promise<void> | void; name?: string } }
}

/** 本入口依赖的最小 Loader 形状；官方 Loader 的完整类型不属于插件边界。 */
interface LoaderLike {
  create(options: { name: string }): Promise<string>
  remove(id: string): void
  resolve(id: string): { fiber?: { await(): Promise<unknown>; dispose(): Promise<void> | void } | undefined }
  store: Record<string, { fiber?: { dispose(): Promise<void> | void } | undefined } | undefined>
  entries(): Iterable<{ options: { id: string; name?: string }; fiber?: unknown }>
}

type ContextWithServices = Context & { get(name: string): unknown; loader: LoaderLike }

/** 当前占用者的可读名称，用于报错与日志。 */
function holderLabel(holder: PickerHolder): string {
  return holder.ctx?.fiber?.name ?? (holder as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'
}

function holderKind(holder: PickerHolder): unknown {
  try {
    return holder.capability?.()?.kind
  } catch {
    return undefined
  }
}

/**
 * 主动移除占用 `directoryPicker` 的原生选择器。
 * 优先走 Loader，让 Loader 同时忘记这个条目，避免后续重组把它“复活”；找不到条目时直接停掉它的 Fiber。
 */
async function evictHolder(ctx: ContextWithServices, holder: PickerHolder): Promise<void> {
  const fiber = holder.ctx?.fiber
  for (const entry of ctx.loader.entries()) {
    if (entry.fiber !== fiber || fiber === undefined) continue
    const live = ctx.loader.store[entry.options.id]
    const disposal = live?.fiber?.dispose()
    ctx.loader.remove(entry.options.id)
    await disposal
    return
  }
  await fiber?.dispose?.()
}

/**
 * 等到 `directoryPicker` 空闲。
 * @returns 浏览后端已经由别处提供时返回 `'already-browse'`，需要本入口挂载时返回 `'free'`。
 * @throws 超过总时限仍被占用，或被无法判断类型的实现占用。
 */
export async function waitForFreeDirectoryPicker(
  ctx: ContextWithServices,
  options: { pollMs?: number; graceMs?: number; deadlineMs?: number } = {},
): Promise<'free' | 'already-browse'> {
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS
  const graceMs = options.graceMs ?? GRACE_MS
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS
  const started = Date.now()
  let evicted = false
  for (;;) {
    const holder = ctx.get(SERVICE_NAME) as PickerHolder | undefined
    if (holder === undefined) return 'free'
    const kind = holderKind(holder)
    if (kind === 'browse') return 'already-browse'
    const elapsed = Date.now() - started
    if (elapsed >= deadlineMs) {
      throw new Error(
        `directoryPicker 仍被 ${holderLabel(holder)}（${typeof kind === 'string' ? kind : '未知类型'}）占用，`
        + `无法挂载目录浏览后端；等待了 ${String(deadlineMs)}ms`,
      )
    }
    if (!evicted && elapsed >= graceMs && kind === 'native') {
      evicted = true
      await evictHolder(ctx, holder)
      continue
    }
    await delay(pollMs)
  }
}

/** 官方自适应选择器同款：把后端作为 Loader 条目挂在根树里，停用时随本入口一并移除。 */
export async function apply(ctx: Context): Promise<void> {
  const host = ctx as ContextWithServices
  await ctx.effect(async () => {
    if (await waitForFreeDirectoryPicker(host) === 'already-browse') return async () => {}
    const id = await host.loader.create({ name: BROWSE_BACKEND })
    const unmount = async (): Promise<void> => {
      const entry = host.loader.store[id]
      if (entry === undefined) return
      const disposal = entry.fiber?.dispose()
      host.loader.remove(id)
      await disposal
    }
    try {
      const entry = host.loader.resolve(id)
      if (entry.fiber === undefined) throw new Error(`directory-picker-pin: failed to load ${BROWSE_BACKEND}`)
      await entry.fiber.await()
    } catch (cause) {
      // 失败时不留下半挂载的后端，否则重试会和它自己的登记冲突。
      await unmount()
      throw cause
    }
    return unmount
  }, 'codingns4dsh: directory-picker browse backend')
}
