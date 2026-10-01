/**
 * 安装引导条。
 *
 * 页面早期注入的脚本已经捕获了 `beforeinstallprompt`（并暂停默认横幅），这里只
 * 负责展示与交互：
 * - Android/Chromium：显示“安装”按钮，点击后调用捕获到的事件；
 * - iOS：没有安装 API，展示“分享 → 添加到主屏幕”指引；
 * - 已安装（standalone）、回环入口、或用户关闭过 → 不显示。
 *
 * 样式内联并带 `env(safe-area-inset-bottom)`，避免被 Home 指示条遮住。
 */
import { resolveCodingNsTranslator, type CodingNsLocale } from './locale.js'

export interface PwaInstallSnapshot {
  readonly loopback?: boolean
  readonly installed?: boolean
  readonly marker?: boolean
  readonly installPromptAvailable?: boolean
  readonly sw?: string
}

export interface PwaInstallPromptWindowLike {
  addEventListener(type: string, listener: (event: never) => void): void
  removeEventListener(type: string, listener: (event: never) => void): void
  matchMedia?: ((query: string) => { matches: boolean }) | undefined
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void } | undefined
  navigator?: { userAgent?: string; platform?: string; maxTouchPoints?: number } | undefined
  __CODINGNS_PWA__?: PwaInstallSnapshot | undefined
  __CODINGNS_PWA_PROMPT__?: (() => Promise<string>) | undefined
}

export interface PwaInstallPromptDocumentLike {
  body?: { appendChild(node: unknown): void; removeChild(node: unknown): void } | undefined
  createElement(tag: string): PwaInstallPromptElementLike
}

export interface PwaInstallPromptElementLike {
  style: Record<string, string>
  textContent?: string | null
  appendChild(node: unknown): void
  removeChild(node: unknown): void
  addEventListener(type: string, listener: () => void): void
  remove(): void
}

export interface PwaInstallPromptOptions {
  readonly window?: PwaInstallPromptWindowLike | undefined
  readonly document?: PwaInstallPromptDocumentLike | undefined
  /** DSH 语言运行时；未提供时退回内置中文词典。 */
  readonly locale?: CodingNsLocale | undefined
  /** 文案覆盖；缺省由 `locale` 词典生成。 */
  readonly text?: { readonly install: string; readonly hint: string; readonly dismiss: string; readonly iosHint: string } | undefined
  /** 用户点击“安装”后的回调（用于写入本地诊断/埋点）。 */
  readonly onOutcome?: ((outcome: string) => void) | undefined
}

export interface PwaInstallPromptController {
  dispose(): void
  /** 重新评估是否展示；返回当前是否展示。 */
  refresh(): boolean
}

export const PWA_INSTALL_DISMISS_KEY = 'codingns4dsh.pwa.installPromptDismissed'

/** 启动安装引导条；不满足条件时不创建任何节点。 */
export function startPwaInstallPrompt(options: PwaInstallPromptOptions = {}): PwaInstallPromptController {
  const hostWindow = options.window ?? (globalThis as unknown as PwaInstallPromptWindowLike)
  const hostDocument = options.document ?? (globalThis as unknown as PwaInstallPromptDocumentLike)
  const t = resolveCodingNsTranslator(options.locale)
  const text = options.text ?? {
    install: t('pwaPrompt.install'),
    hint: t('pwaPrompt.hint'),
    dismiss: t('pwaPrompt.dismiss'),
    iosHint: t('pwaPrompt.iosHint'),
  }
  let element: PwaInstallPromptElementLike | undefined
  let removeListeners: (() => void) | undefined

  const evaluate = (): 'hidden' | 'prompt' | 'ios' => {
    const state = hostWindow.__CODINGNS_PWA__
    if (state === undefined) return 'hidden'
    if (state.loopback === true || state.installed === true) return 'hidden'
    if (hostWindow.__CODINGNS_PWA_PROMPT__ === undefined && state.installPromptAvailable !== true) {
      // 没有安装事件：只有 iOS 才值得展示手把手指引。
      return isIos(hostWindow) ? 'ios' : 'hidden'
    }
    return 'prompt'
  }

  const build = (mode: 'prompt' | 'ios'): PwaInstallPromptElementLike | undefined => {
    if (hostDocument.body === undefined || typeof hostDocument.createElement !== 'function') return undefined
    const root = hostDocument.createElement('div')
    root.style.position = 'fixed'
    root.style.left = '12px'
    root.style.right = '12px'
    // 悬浮在对话区上方，但留出输入框与安全区。
    root.style.bottom = 'calc(16px + env(safe-area-inset-bottom, 0px))'
    root.style.zIndex = '2147483000'
    root.style.display = 'flex'
    root.style.alignItems = 'center'
    root.style.gap = '10px'
    root.style.padding = '10px 12px'
    root.style.borderRadius = '12px'
    root.style.background = 'var(--dsw-alias-bg-layer-3, rgba(15, 23, 42, 0.96))'
    root.style.color = 'var(--dsw-alias-label-primary, CanvasText)'
    root.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.35)'
    root.style.fontSize = '12px'
    root.style.lineHeight = '1.5'

    const message = hostDocument.createElement('span')
    message.style.flex = '1 1 auto'
    message.style.minWidth = '0'
    message.textContent = mode === 'ios' ? `${text.hint} ${text.iosHint}` : text.hint
    root.appendChild(message)

    if (mode === 'prompt') {
      const install = hostDocument.createElement('button')
      install.style.flex = '0 0 auto'
      install.style.padding = '6px 12px'
      install.style.borderRadius = '8px'
      install.style.border = '0'
      install.style.cursor = 'pointer'
      install.style.background = 'var(--dsw-alias-button-primary-fill, #3b82f6)'
      install.style.color = '#ffffff'
      install.textContent = text.install
      install.addEventListener('click', () => {
        const prompt = hostWindow.__CODINGNS_PWA_PROMPT__
        if (prompt === undefined) return
        void prompt().then((outcome) => {
          options.onOutcome?.(outcome)
          if (outcome === 'accepted') hide()
          else refresh()
        }).catch(() => undefined)
      })
      root.appendChild(install)
    }

    const dismiss = hostDocument.createElement('button')
    dismiss.style.flex = '0 0 auto'
    dismiss.style.padding = '6px 10px'
    dismiss.style.borderRadius = '8px'
    dismiss.style.border = '0'
    dismiss.style.cursor = 'pointer'
    dismiss.style.background = 'transparent'
    dismiss.style.color = 'var(--dsw-alias-label-secondary, GrayText)'
    dismiss.textContent = text.dismiss
    dismiss.addEventListener('click', () => {
      markDismissed(hostWindow)
      hide()
    })
    root.appendChild(dismiss)
    return root
  }

  const hide = (): void => {
    removeListeners?.()
    removeListeners = undefined
    if (element !== undefined) {
      try {
        element.remove()
      } catch {
        try { hostDocument.body?.removeChild(element) } catch { /* 节点已不在文档里 */ }
      }
      element = undefined
    }
  }

  const refresh = (): boolean => {
    if (isDismissed(hostWindow)) {
      hide()
      return false
    }
    const mode = evaluate()
    if (mode === 'hidden') {
      hide()
      return false
    }
    if (element !== undefined) return true
    const node = build(mode)
    if (node === undefined) return false
    hostDocument.body?.appendChild(node)
    element = node
    const onAvailable = (): void => { hide(); refresh() }
    const onInstalled = (): void => { hide() }
    try {
      hostWindow.addEventListener('codingns-pwa-install-available', onAvailable as (event: never) => void)
      hostWindow.addEventListener('codingns-pwa-installed', onInstalled as (event: never) => void)
      removeListeners = () => {
        hostWindow.removeEventListener('codingns-pwa-install-available', onAvailable as (event: never) => void)
        hostWindow.removeEventListener('codingns-pwa-installed', onInstalled as (event: never) => void)
      }
    } catch {
      removeListeners = undefined
    }
    return true
  }

  refresh()
  return { dispose: hide, refresh }
}

function isDismissed(windowLike: PwaInstallPromptWindowLike): boolean {
  try {
    return windowLike.localStorage?.getItem(PWA_INSTALL_DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

function markDismissed(windowLike: PwaInstallPromptWindowLike): void {
  try {
    windowLike.localStorage?.setItem(PWA_INSTALL_DISMISS_KEY, '1')
  } catch {
    // 隐私模式下 localStorage 可能不可写；只影响“记住关闭”这一便利功能。
  }
}

function isIos(windowLike: PwaInstallPromptWindowLike): boolean {
  const navigatorLike = windowLike.navigator
  const agent = navigatorLike?.userAgent ?? ''
  if (/iPad|iPhone|iPod/u.test(agent)) return true
  // iPadOS 桌面模式伪装成 Mac，用触摸点数补充判断。
  return /Macintosh/u.test(agent) && (navigatorLike?.maxTouchPoints ?? 0) > 1
}
