/**
 * 设置页顶部的 GitHub Star 推广条。
 *
 * 结构与 CC Switch 的推广横幅同构：左侧品牌标识与版本胶囊，中间一句引导文案，
 * 右侧一个跳转 GitHub 仓库的按钮。颜色与几何全部走 DSH 主题令牌（见
 * {@link installSettingsPromoStyles}），因此明暗主题下都不会出现白底白字。
 *
 * 组件是纯展示的，不读写设置、不依赖设置作用域，因此不会给设置页引入新的
 * `useSyncExternalStore` 快照或写入循环。
 */
import { createElement, useEffect } from 'react'
import type { ReactElement } from 'react'
import { useCodingNsTranslator, type CodingNsLocale } from './locale.js'
import { CODINGNS_VERSION } from '../shared/contracts/version.js'
import { installSettingsPromoStyles, settingsPromoClass } from './settings-promo-styles.js'

/** Codingns4DSH 的 GitHub 仓库；设置页的版本信息与推广按钮共用同一个地址。 */
export const CODINGNS_GITHUB_URL = 'https://github.com/jingyi0605/Codingns4DSH'

export interface SettingsPromoProps {
  readonly locale: CodingNsLocale
}

/**
 * 渲染推广条。
 *
 * @param props.locale - DSH 语言服务；文案由 `codingns` 命名空间提供。
 */
export function CodingNsSettingsPromo({ locale }: SettingsPromoProps): ReactElement {
  const t = useCodingNsTranslator(locale)
  useEffect(() => installSettingsPromoStyles(), [])

  return createElement(
    'aside',
    { className: settingsPromoClass.root, 'aria-label': t('settings.promo.sectionLabel') },
    createElement('div', { className: settingsPromoClass.brand },
      createElement('div', { className: settingsPromoClass.headline },
        createElement(StarBurstIcon, { className: settingsPromoClass.logo }),
        createElement('h3', { className: settingsPromoClass.title }, t('common.brand')),
      ),
      createElement('span', { className: settingsPromoClass.version }, t('settings.promo.version', { version: CODINGNS_VERSION })),
    ),
    createElement('p', { className: settingsPromoClass.text },
      t('settings.promo.starHint'),
      // 手指图标只做强调，不进词典：它不承载语义，也不该被翻译。
      createElement('span', { className: settingsPromoClass.hand, 'aria-hidden': true }, '👉'),
    ),
    createElement('a', {
      className: settingsPromoClass.action,
      href: CODINGNS_GITHUB_URL,
      target: '_blank',
      rel: 'noreferrer',
      'aria-label': t('settings.promo.actionLabel'),
    },
      createElement(GitHubMarkIcon),
      createElement('span', undefined, t('settings.promo.github')),
      createElement('span', { 'aria-hidden': true }, '⭐'),
    ),
  )
}

/**
 * 品牌标识：八芒星。
 *
 * 与附图的彩色星芒同形，但用 `currentColor` 单色绘制，颜色由容器类名交给
 * `--dsw-alias-button-info-fill`，避免在设置页里引入与 DSH 无关的硬编码色。
 */
function StarBurstIcon({ className }: { readonly className: string }): ReactElement {
  return createElement('svg', {
    className,
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
    focusable: false,
  },
    createElement('path', {
      d: 'M12 1.5 13.9 9.2 21.5 7.4 15.6 12 21.5 16.6 13.9 14.8 12 22.5 10.1 14.8 2.5 16.6 8.4 12 2.5 7.4 10.1 9.2Z',
      fill: 'currentColor',
    }),
    createElement('circle', { cx: 12, cy: 12, r: 2.1, fill: 'var(--dsw-alias-bg-layer-1, Canvas)' }),
  )
}

/** GitHub 标记；使用官方 Octocat 轮廓路径，随按钮文字色变化。 */
function GitHubMarkIcon(): ReactElement {
  return createElement('svg', {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'currentColor',
    'aria-hidden': true,
    focusable: false,
  },
    createElement('path', {
      d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
    }),
  )
}
