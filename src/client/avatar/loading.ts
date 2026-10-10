import { createElement } from 'react'
import type { ReactElement } from 'react'
import type { AssistantAvatarCacheStatus } from '../../shared/assistant-avatar-resources.js'
import type { CodingNsTranslator } from '../locale.js'
import { dshThemeColor } from '../theme.js'
import { uiFontSize } from '../font-scale.js'

/** 统一加载反馈；可选字段只在渲染器有真实证据时提供。 */
export interface AssistantAvatarLoadProgress {
  readonly phase: 'engine' | 'resources' | 'rendering' | 'ready'
  readonly loaded?: number
  readonly total?: number
  readonly elapsedMs?: number
  readonly resourcesMs?: number
  readonly cacheBefore?: AssistantAvatarCacheStatus
  readonly cacheAfter?: AssistantAvatarCacheStatus
}

const loadingStyle = `
@keyframes codingns-avatar-orbit { to { transform: rotate(360deg); } }
@keyframes codingns-avatar-breathe { 50% { transform: scale(1.08); opacity: .65; } }
@keyframes codingns-avatar-shimmer { from { transform: translateX(-130%); } to { transform: translateX(330%); } }
[data-codingns-avatar-loading] .codingns-avatar-halo { animation: codingns-avatar-breathe 2.6s ease-in-out infinite; }
[data-codingns-avatar-loading] .codingns-avatar-orbit { animation: codingns-avatar-orbit 3s linear infinite; }
[data-codingns-avatar-loading] .codingns-avatar-indeterminate { animation: codingns-avatar-shimmer 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  [data-codingns-avatar-loading] .codingns-avatar-halo,
  [data-codingns-avatar-loading] .codingns-avatar-orbit,
  [data-codingns-avatar-loading] .codingns-avatar-indeterminate { animation: none; }
}`

/** 百分比只根据已经完成的文件计数生成；未知总数保留循环动画。 */
export function assistantAvatarLoadPercent(progress: AssistantAvatarLoadProgress): number | undefined {
  if (progress.total === undefined || progress.loaded === undefined || !Number.isFinite(progress.total)
    || !Number.isFinite(progress.loaded) || progress.total <= 0) return undefined
  return Math.round(Math.min(1, Math.max(0, progress.loaded / progress.total)) * 100)
}

/** 计数只在同一缓存代际内可相减，Host 重建后不能把相同数字解释成下载为零。 */
function newHostDownloads(progress: AssistantAvatarLoadProgress): number | undefined {
  const before = progress.cacheBefore
  const after = progress.cacheAfter
  if (before === undefined || after === undefined || after.generation !== before.generation || after.downloads < before.downloads) return undefined
  return after.downloads - before.downloads
}

function cacheText(progress: AssistantAvatarLoadProgress, t: CodingNsTranslator): string {
  const before = progress.cacheBefore
  if (before === undefined) return t('avatar.cacheUnknown')
  const initial = t('avatar.cacheBefore', { cached: before.cached, total: before.total })
  const count = newHostDownloads(progress)
  return count === undefined ? initial : `${initial} · ${t('avatar.cacheDownloads', { count })}`
}

/** 透明光晕、轨道光点与细进度条，直接复用插槽尺寸和宿主主题。 */
export function AssistantAvatarLoading({ progress, size, t, showCache = false, diagnostics = false, preview = false, animationOnly = false }: {
  readonly progress: AssistantAvatarLoadProgress; readonly size: number; readonly t: CodingNsTranslator
  readonly showCache?: boolean; readonly diagnostics?: boolean; readonly preview?: boolean
  /** 临时预览仅显示加载动画，下载与引擎准备均不显示文字或进度条。 */
  readonly animationOnly?: boolean
}): ReactElement | null {
  // 即使第三方渲染器仍上报诊断字段，正式环境也不能显示摘要或隐藏的调试 tooltip。
  showCache = !animationOnly && diagnostics && showCache
  if (progress.phase === 'ready' && (!diagnostics || animationOnly)) return null
  const percent = assistantAvatarLoadPercent(progress)
  const compact = size < 120
  const ready = progress.phase === 'ready'
  const elapsed = progress.elapsedMs === undefined ? '' : t('avatar.loadElapsed', { seconds: (progress.elapsedMs / 1000).toFixed(2) })
  const shortElapsed = progress.elapsedMs === undefined ? '' : t('avatar.loadElapsedCompact', { seconds: (progress.elapsedMs / 1000).toFixed(2) })
  const details = [showCache ? cacheText(progress, t) : '', elapsed,
    progress.resourcesMs === undefined ? '' : t('avatar.loadResourcesElapsed', { seconds: (progress.resourcesMs / 1000).toFixed(2) })].filter(Boolean).join(' · ')
  const newDownloads = newHostDownloads(progress)
  if (ready) return createElement('span', { 'data-codingns-avatar-load-summary': true, title: details,
    style: { position: 'absolute', bottom: 0, maxWidth: '100%', fontSize: uiFontSize(10), lineHeight: 1.4, color: dshThemeColor.labelSecondary,
      textAlign: 'center', background: dshThemeColor.cardBackground, borderRadius: 8, padding: '2px 6px' } },
    showCache ? createElement('span', { style: { display: 'block' } }, progress.cacheBefore === undefined ? t('avatar.cacheUnknown')
      : t(compact ? 'avatar.cacheTiny' : 'avatar.cacheShort', { cached: progress.cacheBefore.cached, total: progress.cacheBefore.total })) : null,
    createElement('span', { style: { display: 'block' } }, [showCache && newDownloads !== undefined
      ? t(compact ? 'avatar.cacheDownloadsTiny' : 'avatar.cacheDownloadsCompact', { count: newDownloads }) : '',
      compact && showCache && newDownloads !== undefined ? '' : shortElapsed].filter(Boolean).join(' · ')))
  const phaseText = progress.phase === 'engine' ? t('avatar.loadEngine') : progress.phase === 'rendering' ? t('avatar.loadRendering') : t('avatar.loading')
  const orbSize = preview ? 14 : Math.min(80, size * (compact ? .3 : .46))
  const cache = progress.cacheBefore
  const cacheLabel = compact ? cache === undefined ? t('avatar.cacheUnknownCompact') : t('avatar.cacheTiny', { cached: cache.cached, total: cache.total }) : cacheText(progress, t)
  return createElement('div', { 'data-codingns-avatar-loading': progress.phase, role: 'status', 'aria-label': phaseText,
    ...(showCache ? { title: cacheText(progress, t) } : {}),
    style: { position: 'absolute', inset: preview ? 'auto 0 0' : 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: compact || preview ? 4 : 10,
      ...(preview ? { padding: '5px 4px', borderRadius: 10, background: dshThemeColor.cardBackground } : {}),
      pointerEvents: 'none', color: dshThemeColor.labelSecondary, textAlign: 'center' } },
    createElement('style', null, loadingStyle),
    createElement('div', { style: { display: 'flex', flexDirection: preview ? 'row' : 'column', alignItems: 'center', gap: compact || preview ? 4 : 10 } },
    createElement('div', { 'aria-hidden': true, style: { position: 'relative', flexShrink: 0, width: orbSize, height: orbSize, color: dshThemeColor.accent } },
      createElement('div', { className: 'codingns-avatar-halo', style: { position: 'absolute', inset: '-14%', borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(112, 148, 255, .24), rgba(132, 204, 247, .10) 55%, transparent 72%)' } }),
      createElement('div', { className: 'codingns-avatar-orbit', style: { position: 'absolute', inset: 0, borderRadius: '50%', border: '1px solid rgba(112, 148, 255, .20)' } },
        createElement('span', { style: { position: 'absolute', top: -3, left: '50%', width: 6, height: 6, borderRadius: '50%', background: 'currentColor', boxShadow: '0 0 12px rgba(112, 148, 255, .5)' } })),
      createElement('svg', { viewBox: '0 0 64 64', style: { position: 'absolute', inset: '20%', width: '60%', height: '60%' }, fill: 'none' },
        createElement('path', { d: 'M32 9C35 23 41 29 55 32C41 35 35 41 32 55C29 41 23 35 9 32C23 29 29 23 32 9Z', fill: 'currentColor', opacity: .85 }),
        createElement('circle', { cx: 51, cy: 12, r: 3, fill: 'currentColor', opacity: .4 }))),
    animationOnly ? null : createElement('span', { style: { fontSize: compact || preview ? 10 : size < 160 ? 11 : 13, fontWeight: 500 } }, compact || preview ? t('avatar.loadingCompact') : phaseText)),
    animationOnly ? null : createElement('div', { role: 'progressbar', 'aria-label': t('avatar.loadProgress'), 'aria-valuemin': 0, 'aria-valuemax': 100,
      ...(percent === undefined ? {} : { 'aria-valuenow': percent }),
      style: { width: Math.min(130, size * .74), height: 3, flexShrink: 0, borderRadius: 3, overflow: 'hidden', background: 'rgba(112, 148, 255, .15)' } },
      createElement('div', { className: percent === undefined ? 'codingns-avatar-indeterminate' : undefined,
        style: { width: percent === undefined ? '30%' : `${percent}%`, height: '100%', borderRadius: 3,
          background: 'linear-gradient(90deg, #81c9ed, #7791f7)', transition: 'width .2s ease' } })),
    animationOnly ? null : createElement('span', { style: { fontSize: uiFontSize(10), lineHeight: 1.5, padding: '0 6px', maxWidth: '100%' } },
      percent === undefined ? null : `${progress.loaded}/${progress.total} · ${percent}%`,
      showCache ? createElement('span', { style: { display: 'block' } }, cacheLabel) : null))
}
