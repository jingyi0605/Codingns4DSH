import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 开发桥只由 Stage0 启动器开启，发布包和其他 Profile 不载入仓库脚本。 */
export function registerStage0DevHmr(ctx: Context): void {
  const repositoryRoot = process.env.CODINGNS4DSH_STAGE0_REPO_ROOT
  if (process.env.CODINGNS4DSH_PROFILE_NAME !== 'stage0' || !repositoryRoot) return
  if (!process.env.CODINGNS4DSH_STAGE0_LAUNCHER) return
  const script = pathToFileURL(join(repositoryRoot, 'scripts/stage0-client-hmr.mjs')).href
  ctx.inject(['clientModules', 'webServer'], async (devCtx) => {
    const runtime = await import(script) as { apply(context: Context): Promise<void> }
    await runtime.apply(devCtx)
  })
}
