import { createElement, useEffect, useRef, useState, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import { Menu, relativeTime, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TerminalTextSnapshot, TerminalShareTarget } from '../../shared/contracts/terminal-share.js'
import type { CodingNsTranslator } from '../locale.js'
import { providerVisual } from '../provider-icons.js'
import { sessionAdapterId, subscribeSessionAdapters } from '../session-adapter-cache.js'
import { resolvePlusIcon } from '../../dsh-capabilities/client/primitives-adapter.js'
import { terminalClass } from './styles.js'
import type { TerminalSharing } from './sharing.js'

const NEW_SESSION_ITEM = 'terminal-share:new-session'

interface Props {
  readonly sharing: TerminalSharing
  readonly snapshot: TerminalTextSnapshot | undefined
  readonly sessionId: string
  readonly anchor: ReactNode
  readonly t: CodingNsTranslator
  readonly onClose: () => void
  readonly align?: 'start' | 'end'
}

/** 工具栏和选区按钮复用同一个原生菜单，选中会话即加入固定引用卡片。 */
export function TerminalShareMenu({ sharing, snapshot, sessionId, anchor, t, onClose, align = 'end' }: Props): ReactElement {
  const [targets, setTargets] = useState<readonly TerminalShareTarget[]>([])
  const [limit, setLimit] = useState(5)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [now, setNow] = useState(Date.now)
  const requestRef = useRef<TerminalTextSnapshot>()

  useEffect(() => {
    setLimit(5)
    setTargets([])
    setError('')
  }, [snapshot])

  useEffect(() => {
    if (snapshot === undefined) return
    // 菜单打开期间共用一个时钟，关闭即释放，不为每个会话建立定时器。
    setNow(Date.now())
    const timer = globalThis.setInterval(() => setNow(Date.now()), 60_000)
    return () => globalThis.clearInterval(timer)
  }, [snapshot])

  useEffect(() => {
    requestRef.current = snapshot
    if (snapshot === undefined) return
    const abort = new AbortController()
    setLoading(true)
    void sharing.targets(sessionId, limit, abort.signal).then((items) => {
      if (!abort.signal.aborted) setTargets(items)
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setError(messageOf(cause))
    }).finally(() => { if (!abort.signal.aborted) setLoading(false) })
    return () => abort.abort()
  }, [attempt, limit, sessionId, sharing, snapshot])

  const select = async (id: string): Promise<void> => {
    if (busyRef.current || snapshot === undefined) return
    if (id === 'more') { setLimit((value) => value + 5); return }
    if (id === 'retry') { setError(''); setAttempt((value) => value + 1); return }
    if (id !== NEW_SESSION_ITEM && !targets.some((item) => item.sessionId === id)) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const label = t('terminalShare.referenceLabel', { title: snapshot.title, lines: snapshot.lineCount })
      if (id === NEW_SESSION_ITEM) await sharing.shareToNew(snapshot, sessionId, label)
      else await sharing.share(snapshot, id, label)
      if (requestRef.current === snapshot) onClose()
    } catch (cause) { if (requestRef.current === snapshot) setError(messageOf(cause)) }
    finally { busyRef.current = false; setBusy(false) }
  }

  const unavailable = !sharing.canReference() ? t('terminalShare.referenceUnavailable')
    : snapshot?.text.trim() === '' ? t('terminalShare.empty') : ''
  const items: MenuEntry[] = [{ type: 'label', id: 'heading', text: t('terminalShare.menuTitle') }]
  if (snapshot?.range === 'selection' && snapshot.truncated) items.push({ type: 'label', id: 'truncated', text: t('terminalShare.selectionLimited', { lines: snapshot.lineCount }) })
  items.push({ id: NEW_SESSION_ITEM, disabled: busy || unavailable !== '',
    label: createElement('span', { className: terminalClass.shareTargetRow },
      createElement('span', { className: terminalClass.shareTargetIcon, 'aria-hidden': true }, createElement(resolvePlusIcon(), { size: 18 })),
      createElement('span', { className: terminalClass.shareTargetTitle }, t('terminalShare.new')),
    ),
  })
  if (loading) items.push({ id: 'loading', label: t('terminalShare.loading'), disabled: true })
  else items.push(...targets.map((item) => ({
    id: item.sessionId,
    label: createElement(TerminalShareTargetRow, { item, now, t }),
    disabled: busy || unavailable !== '',
  })))
  const footer: MenuEntry[] = []
  if (busy) footer.push({ id: 'busy', label: t('terminalShare.adding'), disabled: true })
  if (error !== '' || unavailable !== '') footer.push({ type: 'label', id: 'error', text: error || unavailable })
  if (error !== '') footer.push({ id: 'retry', label: t('terminalShare.retry'), disabled: busy })
  else if (!loading && targets.length >= limit) footer.push({ id: 'more', label: t('terminalShare.more'), disabled: busy })
  return createElement(Menu, {
    // 新建入口始终在首行，键盘默认也落在该操作上。
    open: snapshot !== undefined, portal: true, autoFocus: true, compact: true, align,
    anchor, items, footer, selectedId: NEW_SESSION_ITEM, selection: 'fill', listClassName: terminalClass.shareMenu,
    onClose: () => { if (!busyRef.current) onClose() }, onSelect: (id) => { void select(id) },
  })
}

/** 图标与侧栏共用适配器绑定缓存，时间也使用原生的分段算法。 */
function TerminalShareTargetRow({ item, now, t }: {
  readonly item: TerminalShareTarget
  readonly now: number
  readonly t: CodingNsTranslator
}): ReactElement {
  const readAdapter = (): string => sessionAdapterId(item.sessionId) ?? (item.adapterId || 'dsh')
  const adapterId = useSyncExternalStore(subscribeSessionAdapters, readAdapter, readAdapter)
  const visual = providerVisual(adapterId, t)
  const title = item.title === item.sessionId || item.title === '' ? t('terminalShare.untitled') : item.title
  const updatedAt = item.updatedAt
  const hasTime = updatedAt !== undefined && Number.isFinite(updatedAt) && updatedAt > 0
  const time = hasTime ? relativeTime(updatedAt, now) : undefined
  return createElement('span', { className: terminalClass.shareTargetRow },
    createElement('span', { className: terminalClass.shareTargetIcon, role: 'img', 'aria-label': visual.displayName, title: visual.displayName },
      visual.iconUrl === undefined ? '?' : createElement('img', { src: visual.iconUrl, alt: '', width: 18, height: 18 }),
    ),
    createElement('span', { className: terminalClass.shareTargetTitle, title }, title),
    createElement('time', { className: terminalClass.shareTargetTime,
      dateTime: hasTime ? new Date(updatedAt).toISOString() : undefined,
      title: hasTime ? new Date(updatedAt).toLocaleString() : t('terminalShare.time.unknown'),
    }, time === undefined ? '—' : t(`terminalShare.time.${time.unit}`, { n: time.n })),
  )
}

function messageOf(value: unknown): string { return value instanceof Error ? value.message : String(value) }
