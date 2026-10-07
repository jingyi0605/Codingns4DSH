import { createElement, useSyncExternalStore, type ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCodingNsTranslator, type CodingNsLocale, type CodingNsTranslator } from '../locale.js'
import { terminalClass } from './styles.js'
import type { TerminalLogPreviewState, TerminalSharing } from './sharing.js'

/** 根级模态框常驻于 shell.overlay，关闭和焦点恢复由原生 Modal 处理。 */
export function TerminalLogPreview({ sharing, locale }: {
  readonly sharing: TerminalSharing
  readonly locale: CodingNsLocale
}): ReactElement | null {
  const state = useSyncExternalStore(sharing.subscribePreview, sharing.getPreviewSnapshot, sharing.getPreviewSnapshot)
  const t = useCodingNsTranslator(locale)
  if (state === undefined) return null
  return createElement(Modal, {
    open: true, headless: true, title: t('terminalShare.preview.title'),
    className: terminalClass.previewModal, onClose: sharing.closePreview,
  },
    createElement('div', { className: terminalClass.previewHeader },
      createElement('h2', undefined, t('terminalShare.preview.title')),
      createElement(Button, { variant: 'ghost', size: 'sm', onClick: sharing.closePreview, ...{ 'data-modal-autofocus': true } }, t('terminalShare.preview.close')),
    ),
    createElement(TerminalLogPreviewContent, { state, t }),
  )
}

/** 只显示引用中的固定正文，按纯文本转义，长行和长日志均在内容区域滚动。 */
export function TerminalLogPreviewContent({ state, t }: {
  readonly state: TerminalLogPreviewState
  readonly t: CodingNsTranslator
}): ReactElement {
  if ('error' in state) return createElement('p', { role: 'alert', className: terminalClass.previewError }, state.error)
  const { snapshot } = state
  return createElement('div', { className: terminalClass.previewBody },
    createElement('p', { className: terminalClass.previewMetadata },
      t('terminalShare.preview.metadata', { title: snapshot.title, lines: snapshot.lineCount, time: new Date(snapshot.capturedAt).toLocaleString() }),
      snapshot.truncated && createElement('span', undefined, t('terminalShare.snapshot.truncated')),
    ),
    createElement('pre', { className: terminalClass.previewText, tabIndex: 0, 'aria-label': t('terminalShare.preview.title') }, snapshot.text || t('terminalShare.empty')),
  )
}
