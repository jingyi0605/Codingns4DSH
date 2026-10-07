import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 必须由专用 Stage0 启动器装配，普通开发构建或同名 Profile 不开启调试界面。 */
export function isStage0Runtime(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.CODINGNS4DSH_PROFILE_NAME === 'stage0'
    && Boolean(environment.CODINGNS4DSH_STAGE0_REPO_ROOT?.trim())
    && Boolean(environment.CODINGNS4DSH_STAGE0_LAUNCHER?.trim())
}

/** 开发桥只由 Stage0 启动器开启，发布包和其他 Profile 不载入仓库脚本。 */
export function registerStage0DevHmr(ctx: Context): void {
  if (!isStage0Runtime()) return
  const repositoryRoot = process.env.CODINGNS4DSH_STAGE0_REPO_ROOT
  const script = pathToFileURL(join(repositoryRoot!, 'scripts/stage0-client-hmr.mjs')).href
  ctx.inject(['clientModules', 'webServer'], async (devCtx) => {
    const runtime = await import(script) as { apply(context: Context): Promise<void> }
    await runtime.apply(devCtx)
  })
}
