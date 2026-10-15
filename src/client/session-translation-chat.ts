import { createElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { AssistantBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  DisclosureRow,
  FileTypeIcon,
  IconCheckOutlineRegular,
  IconCopyOutlineRegular,
  IconThinkOutlineRegular,
  JsonBlock,
  MarkdownText,
  TextShimmer,
  fileExtension,
  fileSizeText,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import * as messagePrimitives from '@deepseek-ai/dsh-client-ui-primitives'
import { createDshCapabilityRegistry, type DshCapabilityRuntimeFacts } from '../dsh-capabilities/routes.js'
import type { MessagePresentation } from '../dsh-capabilities/client/message-presentation-adapter.js'
import { useDismissOnOutsidePointer } from './popup-dismiss.js'
import { dshThemeColor } from './theme.js'
import { TRANSLATION_GLYPH_PATHS, TRANSLATION_GLYPH_SIZE, TRANSLATION_PENDING_BADGE_STYLE, TRANSLATION_STATUS_BADGE_STYLE } from '../shared/translation-indicator.js'
import { uiFontSize } from './font-scale.js'
import { useCliSessionTranslationEnabled } from './cli-slots.js'
import { watchPendingTranslationTargets, type PendingTranslationTarget } from './session-translation-pending-dom.js'
import type { CodingNsClientServices } from './features/types.js'
import type { CodingNsTranslator } from './locale.js'
import type { SessionTranslationInputRecord, SessionTranslationLanguage, SessionTranslationModel, SessionTranslationOutputKind, SessionTranslationRecord } from '../shared/contracts/session-translation.js'
import { readSessionTranslationMetrics } from '../shared/contracts/session-translation.js'

interface EventSourceLike {
  getSnapshot(): { readonly entries?: readonly unknown[] }
  subscribe(listener: () => void): () => void
}

interface TranslationPopupPosition {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly maxHeight: number
  readonly placement: 'above' | 'below'
}

interface TranslationActionProps {
  readonly messageId: string
  readonly messageRole?: 'user' | 'assistant'
  readonly services: CodingNsClientServices
  readonly translationT: CodingNsTranslator
  /** Absent only for a pending submission in a translation-enabled session. */
  readonly record?: SessionTranslationRecord
  readonly original?: string
  readonly popupAlign?: 'start' | 'end'
  readonly inline?: boolean
}

interface MarkdownTranslationLabels extends MarkdownLabels {
  readonly code: MarkdownLabels['code'] & {
    readonly toolbarLabels: NonNullable<MarkdownLabels['code']['toolbarLabels']>
  }
}

/**
 * DSH 的表现层工厂渲染入口。`fallback` 是工厂缺失时的兜底内容，缺省渲染 null，
 * 所以调用方必须显式传入，不能把可见内容完全交给工厂。
 */
type TranslationFactorySlot = (name: string, props: Record<string, unknown>, options?: { readonly fallback?: ReactNode }) => ReactNode

interface UserContentParts {
  readonly text: string
  readonly attachments: readonly ({ readonly type: 'image'; readonly attachment: unknown } | { readonly type: 'file'; readonly file: Record<string, unknown> })[]
  readonly rest: readonly unknown[]
}

/**
 * 把翻译状态和查看原文的入口放回对应消息块，不占用 AI 回复底部的统一操作栏。
 */
export function TranslationAction(props: TranslationActionProps): ReactElement | null {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const [popupPosition, setPopupPosition] = useState<TranslationPopupPosition | null>(null)
  useDismissOnOutsidePointer(rootRef, open, () => setOpen(false), { portal: popupRef })
  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') {
      setPopupPosition(null)
      return undefined
    }
    const updatePosition = (): void => {
      const button = buttonRef.current
      if (button === null) return
      const rect = button.getBoundingClientRect()
      const edge = 12
      const gap = 8
      const width = Math.max(1, Math.min(420, window.innerWidth - edge * 2))
      const availableAbove = Math.max(0, rect.top - gap - edge)
      const availableBelow = Math.max(0, window.innerHeight - rect.bottom - gap - edge)
      const preferredHeight = Math.min(440, window.innerHeight * 0.65)
      const placement = availableAbove >= preferredHeight
        || (availableBelow < preferredHeight && availableAbove > availableBelow)
        ? 'above'
        : 'below'
      const availableHeight = placement === 'above' ? availableAbove : availableBelow
      const maxHeight = Math.min(preferredHeight, availableHeight)
      const desiredLeft = props.popupAlign === 'end' ? rect.right - width : rect.left
      const maxLeft = Math.max(edge, window.innerWidth - edge - width)
      setPopupPosition({
        left: Math.min(maxLeft, Math.max(edge, desiredLeft)),
        top: placement === 'above' ? rect.top - gap : rect.bottom + gap,
        width,
        maxHeight,
        placement,
      })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open, props.popupAlign])

  const record = props.record
  const pending = record === undefined
  const failed = record?.failed === true
  const alreadyTargetLanguage = record?.alreadyTargetLanguage === true
  const statusText = pending
    ? props.translationT('translation.statusTranslating')
    : failed
      ? props.translationT('translation.statusFailed')
      : alreadyTargetLanguage
        ? props.translationT('translation.statusNotNeeded')
        : props.translationT('translation.statusTranslated')
  const statusColor = pending ? dshThemeColor.accent : failed ? dshThemeColor.error : alreadyTargetLanguage ? dshThemeColor.accent : dshThemeColor.success
  const detailsId = `codingns-translation-details-${safeDomId(props.messageId)}`
  const details = open && popupPosition !== null ? createElement('div', {
    ref: popupRef,
    role: 'dialog',
    'aria-label': props.translationT('translation.detailsTitle'),
    id: detailsId,
    style: {
      position: 'fixed',
      zIndex: 2147483647,
      left: popupPosition.left,
      top: popupPosition.top,
      width: popupPosition.width,
      maxHeight: popupPosition.maxHeight,
      boxSizing: 'border-box',
      ...(popupPosition.placement === 'above' ? { transform: 'translateY(-100%)' } : {}),
      overflow: 'auto',
      padding: '10px 12px',
      border: `1px solid ${dshThemeColor.border}`,
      borderRadius: 8,
      color: dshThemeColor.labelPrimary,
      background: dshThemeColor.menuBackground,
      boxShadow: '0 8px 24px color-mix(in srgb, CanvasText 16%, transparent)',
      fontSize: uiFontSize(12),
      lineHeight: 1.45,
    },
  },
  createElement('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 10, fontWeight: 600 } },
    createElement('span', undefined, props.translationT('translation.detailsTitle')),
    createElement('span', { role: 'status', 'aria-live': 'polite', style: { color: statusColor, fontWeight: 400 } }, statusText),
  ),
  record?.sourceLanguage === undefined ? null : createElement('div', { style: { marginTop: 8, color: dshThemeColor.labelSecondary } }, `${props.translationT('translation.detectedLanguage')}: ${props.translationT(`translation.language.${record.sourceLanguage}`)}`),
  createElement(DetailBlock, { kind: 'original', translationT: props.translationT, value: record?.original ?? props.original ?? '' }),
  pending ? createElement('progress', { 'aria-label': statusText, style: { display: 'block', width: '100%', height: 4, marginTop: 8, accentColor: dshThemeColor.accent } }) : null,
  pending
    ? createElement('div', { role: 'status', 'aria-live': 'polite', style: { marginTop: 8, color: dshThemeColor.labelSecondary } }, props.translationT('translation.progressHelp'))
    : createElement(DetailBlock, { kind: props.messageRole === 'user' ? 'sent' : 'translated', translationT: props.translationT, value: record.translated }),
  pending ? null : createElement('div', { style: { marginTop: 8, color: dshThemeColor.labelSecondary } }, [
    `${props.translationT('translation.modelUsed')}: ${alreadyTargetLanguage ? props.translationT('translation.modelNotUsed') : formatModel(record.model, props.translationT)}`,
    ...(record.durationMs === undefined ? [] : [`${(record.durationMs / 1000).toFixed(2)} s`]),
    ...(record.totalTokens === undefined ? [] : [`${record.totalTokens} tok`]),
  ].join(' · ')),
  ) : null
  const renderedDetails = details === null
    ? null
    : typeof document === 'undefined' ? details : createPortal(details, document.body)

  return createElement('div', {
    ref: rootRef,
    style: {
      position: 'relative',
      display: 'inline-flex',
      alignItems: 'center',
      verticalAlign: 'middle',
      ...(props.inline === true ? { marginInlineStart: 4 } : {}),
    },
    'data-codingns-translation-action': props.messageId,
  },
  createElement('button', {
    ref: buttonRef,
    type: 'button',
    title: `${statusText} · ${props.translationT('translation.viewDetails')}`,
    'aria-label': `${statusText} · ${props.translationT('translation.viewDetails')}`,
    'aria-expanded': open,
    'aria-controls': detailsId,
    onClick: () => setOpen((value) => !value),
    style: translationButtonStyle,
  },
  createElement(TranslationGlyph),
  createElement('span', {
    'aria-hidden': true,
    'data-codingns-translation-pending': pending || undefined,
    style: {
      ...TRANSLATION_STATUS_BADGE_STYLE,
      ...(pending ? TRANSLATION_PENDING_BADGE_STYLE : { background: statusColor }),
    },
  }, pending ? null : failed ? '!' : '✓'),
  ),
  renderedDetails,
  )
}

function PendingTranslationActions(props: {
  readonly services: CodingNsClientServices
  readonly translationT: CodingNsTranslator
  readonly sessionId?: string
  readonly useSession?: <T>(selector: (state: { readonly subagent?: unknown }) => T) => T
}): ReactElement {
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const [targets, setTargets] = useState<readonly PendingTranslationTarget[]>([])
  const enabled = useCliSessionTranslationEnabled(props.sessionId, props.services.rpc)
  const subagent = props.useSession?.((state) => state.subagent)
  const eligible = enabled && subagent == null && !props.sessionId?.startsWith('codingns-assistant-')
  useLayoutEffect(() => {
    setTargets([])
    if (!eligible || anchorRef.current === null) return undefined
    return watchPendingTranslationTargets(anchorRef.current, setTargets)
  }, [eligible, props.sessionId])
  return createElement('span', { ref: anchorRef, style: { display: 'none' } },
    ...targets.map((target) => createPortal(createElement(PendingTranslationAction, {
      services: props.services,
      translationT: props.translationT,
      original: target.original,
    }), target.container, String(target.key))),
  )
}

function PendingTranslationAction(props: Omit<TranslationActionProps, 'messageId'>): ReactElement {
  const id = useId()
  return createElement(TranslationAction, { ...props, messageId: `pending-${id}`, messageRole: 'user', popupAlign: 'end' })
}

function TranslationGlyph(): ReactElement {
  return createElement('svg', {
    viewBox: '0 0 24 24',
    width: TRANSLATION_GLYPH_SIZE,
    height: TRANSLATION_GLYPH_SIZE,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  },
  ...TRANSLATION_GLYPH_PATHS.map(d => createElement('path', { key: d, d })),
  )
}

const messageActionButtonStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  border: 0,
  borderRadius: 'var(--dsw-radius-sm, 6px)',
  color: dshThemeColor.labelTertiary,
  background: 'transparent',
  cursor: 'pointer',
}

const translationButtonStyle: CSSProperties = {
  ...messageActionButtonStyle,
  transition: 'background-color 100ms ease, color 100ms ease',
}

const translationDetailTypes = {
  original: { labelKey: 'translation.originalText', color: dshThemeColor.labelSecondary },
  translated: { labelKey: 'translation.translatedText', color: dshThemeColor.accent },
  sent: { labelKey: 'translation.actualSentText', color: dshThemeColor.success },
} as const

function DetailBlock({ kind, translationT, value }: {
  readonly kind: keyof typeof translationDetailTypes
  readonly translationT: CodingNsTranslator
  readonly value: string
}): ReactElement {
  const { labelKey, color } = translationDetailTypes[kind]
  return createElement('div', { style: { marginTop: 8 } },
    createElement('div', {
      style: {
        display: 'inline-block',
        maxWidth: '100%',
        boxSizing: 'border-box',
        marginBottom: 6,
        padding: '2px 8px',
        border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        fontWeight: 600,
        overflowWrap: 'anywhere',
      },
    }, translationT(labelKey)),
    createElement('pre', {
      style: {
        margin: 0,
        color: `color-mix(in srgb, ${color} 45%, ${dshThemeColor.labelPrimary})`,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        fontFamily: 'inherit',
      },
    }, value),
  )
}

/** 按原生 user 节点的结构渲染用户消息；翻译入口只在确实有记录时追加。 */
function UserMessageNodeView(props: any): ReactElement | null {
  const data = props.node.data
  const parts = splitUserContent(data.content)
  const record = readInputRecord({ source: data.source })
  // 这个渲染器以更低优先级遮蔽了 DSH 原生 user 渲染器，因此无论有没有翻译记录
  // 都必须画出消息本身：返回 null 会让整条用户消息从对话里消失。
  const translationRecord = record === undefined ? undefined : inputRecordForAction(record)
  const labels = Array.isArray(data.referenceLabels) ? data.referenceLabels.filter((label: unknown): label is string => typeof label === 'string') : []
  const skillNames = Array.isArray(data.skillNames) ? data.skillNames.filter((name: unknown): name is string => typeof name === 'string') : []
  const showBubble = parts.text !== '' || parts.rest.length > 0
  const images = parts.attachments.filter((attachment) => attachment.type === 'image')
  const compactImages = images.length > 1
  const messageId = `user-${String(data.seq ?? props.node.id ?? 'message')}`
  const chatT = props.t as (key: string, params?: Record<string, unknown>) => string

  return createElement('div', {
    'data-chat-flow-kind': 'user',
    style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 },
  },
  (props.presentation as MessagePresentation).kind === 'factory' ? (props.presentation as MessagePresentation).userContent(props, {
    text: parts.text,
    attachments: parts.attachments.map(item => item.type === 'image' ? { type: 'image', image: { attachment: item.attachment } } : item),
    extraBlocks: parts.rest,
    referenceLabels: labels,
  }, { sessionLabels: labels, skillNames }) : createElement('div', {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 8,
      minWidth: 0,
      maxWidth: 'min(calc(var(--dsh-chat-content-width, 748px) * .702), 82%)',
    },
  },
  parts.attachments.length > 0 ? createElement('div', {
    'data-message-attachments': true,
    style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, maxWidth: '100%' },
  }, ...parts.attachments.map((attachment, index) => attachment.type === 'image'
    ? createElement('div', { key: `image-${index}` }, (props.presentation as MessagePresentation).images(props, { images: [{ attachment: attachment.attachment }], align: 'end', compact: compactImages }))
    : createFileAttachment(attachment.file, index))) : null,
  showBubble ? createElement('div', {
    style: {
      boxSizing: 'border-box',
      maxWidth: '100%',
      padding: '10px 16px',
      borderRadius: 'var(--dsw-radius-xl, 18px)',
      color: dshThemeColor.labelPrimary,
      background: 'var(--dsw-specific-bubble, var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.08)))',
      fontSize: 'var(--dsh-content-font-size, 14px)',
      lineHeight: 'calc(22px + var(--dsh-content-font-delta, 0px))',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    },
  },
  (props.presentation as MessagePresentation).projectText(
    parts.text,
    labels,
    skillNames,
    'skill',
    typeof props.openFile === 'function' && typeof props.openSkill === 'function'
      ? { openFile: props.openFile, openSkill: props.openSkill }
      : undefined,
  ),
  ...parts.rest.map((block, index) => createElement(JsonBlock, {
    key: `extra-${index}`,
    label: chatT('message.extraBlock'),
    payload: block,
    truncatedLabel: (total: number) => chatT('json.truncated', { total }),
  })),
  ) : null,
  labels.length === 0 ? null : createElement('div', {
    style: {
      color: dshThemeColor.labelTertiary,
      fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
      lineHeight: 'calc(18px + var(--dsh-content-font-delta-secondary, 0px))',
    },
  }, chatT('message.referenceSummary', { labels: labels.join(chatT('message.referenceSeparator')) })),
  ),
  createElement('div', {
    style: {
      display: 'flex',
      alignItems: 'center',
      alignSelf: 'flex-end',
      height: 'calc(28px + var(--dsh-content-font-delta, 0px))',
      gap: 8,
      color: dshThemeColor.labelTertiary,
    },
  },
  typeof data.time === 'number' ? createElement('span', {
    style: { paddingRight: 12, color: dshThemeColor.labelTertiary, fontSize: 'var(--dsh-content-font-size-secondary, 13px)', whiteSpace: 'nowrap' },
  }, formatMessageTime(data.time)) : null,
  translationRecord === undefined ? null : createElement(TranslationAction, {
    messageId,
    messageRole: 'user',
    services: props.services,
    translationT: props.translationT,
    popupAlign: 'end',
    record: translationRecord,
  }),
  createElement(CopyAction, { text: parts.text, t: chatT }),
  ),
  )
}

function createFileAttachment(file: Record<string, unknown>, index: number): ReactElement {
  const name = typeof file.name === 'string' ? file.name : ''
  const bytes = typeof file.bytes === 'number' ? file.bytes : 0
  return createElement('span', {
    key: `file-${index}`,
    title: name,
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      minWidth: 0,
      maxWidth: '100%',
      gap: 8,
      padding: '8px 10px',
      border: `1px solid ${dshThemeColor.border}`,
      borderRadius: 8,
      color: dshThemeColor.labelPrimary,
      background: dshThemeColor.surfaceSubtle,
    },
  },
  createElement(FileTypeIcon, { path: name, style: { flex: 'none' } } as never),
  createElement('span', { style: { display: 'flex', flexDirection: 'column', minWidth: 0, textAlign: 'left' } },
    createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
    createElement('span', { style: { color: dshThemeColor.labelSecondary, fontSize: 11 } }, [fileExtension(name).toUpperCase().slice(0, 8), fileSizeText(bytes)].filter(Boolean).join(' ')),
  ),
  )
}

function CopyAction({ text, t: chatT }: { readonly text: string; readonly t: (key: string) => string }): ReactElement {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
  }, [])

  return createElement('button', {
    type: 'button',
    title: copied ? chatT('copied') : chatT('copy'),
    'aria-label': copied ? chatT('copied') : chatT('copy'),
    onClick: () => {
      void writeClipboard(text).then((success) => {
        if (!success) return
        setCopied(true)
        if (timer.current !== undefined) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          timer.current = undefined
          setCopied(false)
        }, 1000)
      })
    },
    style: messageActionButtonStyle,
  }, createElement(copied ? IconCheckOutlineRegular : IconCopyOutlineRegular))
}

function splitUserContent(content: unknown): UserContentParts {
  const text: string[] = []
  const attachments: UserContentParts['attachments'][number][] = []
  const rest: unknown[] = []
  if (typeof content === 'string') return { text: content, attachments, rest }
  if (!Array.isArray(content)) return { text: '', attachments, rest }
  for (const value of content) {
    const block = asRecord(value)
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text)
    else if (block?.type === 'image' && block.attachment !== undefined) attachments.push({ type: 'image', attachment: block.attachment })
    else if (block?.type === 'file' && asRecord(block.attachment) !== undefined) attachments.push({ type: 'file', file: asRecord(block.attachment)! })
    else rest.push(value)
  }
  return { text: text.join(''), attachments, rest }
}

function formatMessageTime(time: number): string {
  const date = new Date(time)
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
  return new Intl.DateTimeFormat(undefined, options).format(date)
}

/** DSH assistant-step renderer: keep each translation action adjacent to its source block. */
function AssistantTranslationNodeView(props: any): ReactElement | null {
  const data = props.node.data
  const blocks = Array.isArray(data.blocks) ? data.blocks as readonly AssistantBlock[] : []
  const streaming = data.status === 'running'
  const chatT = props.t as (key: string, params?: Record<string, unknown>) => string
  const markdownLabels = useMemo(() => createMarkdownLabels(chatT), [chatT])
  const pathImages = useMemo(() => ({ resolve: resolveMarkdownImagePath }), [])
  // 与 DSH 原生 AssistantMarkdown 相同的可见性判据：只有「运行中 / 被中断 / 含正文块」
  // 才渲染内容。这个渲染器遮蔽了原生 assistant-step 渲染器，若在这里因为缺少翻译
  // 记录而返回 null，整段 AI 正文就会从对话里消失。
  const renderable = streaming || data.status === 'interrupted' || blocks.some((block) => block.kind !== 'tool-call')
  // 只有确实需要渲染时才读取事件流：没有翻译的普通会话不再订阅 Session 事件。
  const eventSnapshot = renderable ? readEventSource(props.services, props.sessionId)?.getSnapshot() : undefined
  const hasTranslation = renderable && blocks.some((block) => {
    if (block.kind !== 'reasoning' && block.kind !== 'text') return false
    const outputKind = block.kind === 'reasoning' ? 'reasoning' : 'assistant'
    const embedded = readRecord(block)
    if (embedded !== undefined && (embedded.outputKind === undefined || embedded.outputKind === outputKind)) return true
    return eventSnapshot !== undefined && findTranslationRecordForText(eventSnapshot, block.text, outputKind, data.turn, data.step) !== undefined
  })
  const turn = props.node.location?.kind === 'turn' || props.node.location?.kind === 'step' ? props.node.location.turn : undefined
  const tail = typeof props.useTurnData === 'function' ? props.useTurnData('turn-tail') : undefined
  const finalNode = data.finalNode
  const fileOwner = turn?.status === 'closed' && finalNode !== undefined && tail?.closing?.finalNode?.seq === finalNode.seq
    ? { turn, seq: finalNode.seq, openFile: (path: string) => { void props.openFile(path) } }
    : undefined
  const mentions = fileOwner === undefined || typeof props.fileMentions !== 'function' ? undefined : props.fileMentions(fileOwner)
  const turnProcess = props.turnProcess
  const reasoningHidden = turnProcess !== undefined
    && turnProcess.foldable === true
    && turnProcess.spec?.answerStep === data.step
    && turnProcess.spec?.inlineReasoning === true
    && turnProcess.open !== true
  const rendered: ReactNode[] = []
  const last = blocks.length - 1
  const messageId = typeof finalNode?.messageId === 'string' ? finalNode.messageId : `turn-${data.turn}-step-${data.step}`

  if (!renderable) return null
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block === undefined) continue
    if (props.groupPart === 'reasoning' && block.kind !== 'reasoning') continue
    if (props.groupPart === 'response' && block.kind === 'reasoning') continue
    const running = streaming && index === last
    if (block.kind === 'text') {
      const translationRecord = readRecord(block) ?? (hasTranslation && eventSnapshot !== undefined
        ? findTranslationRecordForText(eventSnapshot, block.text, 'assistant', data.turn, data.step)
        : undefined)
      const displayText = translationRecord?.translated ?? block.text
      rendered.push(createElement('div', {
        key: `text-${index}`,
        'data-codingns-translation-inline': true,
        style: { minWidth: 0 },
      },
      createElement(MarkdownText, { text: displayText, streaming, labels: markdownLabels, fileMentions: mentions, pathImages }),
      translationRecord === undefined ? null : createElement(TranslationAction, {
        messageId: `${messageId}-text-${index}`,
        messageRole: 'assistant',
        services: props.services,
        translationT: props.translationT,
        record: translationRecord,
        inline: true,
      }),
      ))
      continue
    }
    if (block.kind === 'reasoning') {
      const translationRecord = readRecord(block) ?? (hasTranslation && eventSnapshot !== undefined
        ? findTranslationRecordForText(eventSnapshot, block.text, 'reasoning', data.turn, data.step)
        : undefined)
      rendered.push(createElement(AssistantReasoningBlock, {
        key: `reasoning-${index}`,
        messageId: `${messageId}-reasoning-${index}`,
        services: props.services,
        translationT: props.translationT,
        chatT,
        text: block.text,
        ...(translationRecord === undefined ? {} : { translationRecord }),
        running,
        hidden: reasoningHidden,
        reveal: () => turnProcess?.setOpen?.(true),
        useGroupAction: props.useGroupAction,
        renderFactorySlot: props.renderFactorySlot,
        markdownLabels,
        pathImages,
        mentions,
      }))
      continue
    }
    if (block.kind === 'image') {
      const imageGroup = [block]
      while (index + 1 < blocks.length && blocks[index + 1]?.kind === 'image') {
        const next = blocks[index + 1]
        if (next?.kind !== 'image') break
        imageGroup.push(next)
        index += 1
      }
      rendered.push(createElement('div', { key: `images-${index}`, style: { alignSelf: 'flex-start' } }, (props.presentation as MessagePresentation).images(props, { images: imageGroup.map((image) => ({ attachment: image.attachment })), align: 'start' })))
      continue
    }
    if (block.kind === 'other') {
      rendered.push(createElement(JsonBlock, {
        key: `other-${index}`,
        label: chatT('message.unknownBlock'),
        payload: block.block,
        truncatedLabel: (total: number) => chatT('json.truncated', { total }),
      }))
    }
  }

  return createElement('div', {
    'data-streaming': streaming || undefined,
    style: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, color: dshThemeColor.labelPrimary, fontSize: 'var(--dsh-content-font-size, 14px)', lineHeight: 'calc(24px + var(--dsh-content-font-delta, 0px))' },
  },
  ...rendered,
  data.status === 'interrupted' ? createElement('span', {
    style: { alignSelf: 'flex-start', padding: '0 6px', borderRadius: 'var(--dsw-radius-sm, 4px)', color: dshThemeColor.labelTertiary, background: dshThemeColor.surfaceSubtle, fontSize: 11, lineHeight: '18px' },
  }, chatT('message.stopped')) : null,
  )
}

interface AssistantReasoningBlockProps {
  readonly messageId: string
  readonly services: CodingNsClientServices
  readonly translationT: CodingNsTranslator
  readonly chatT: (key: string, params?: Record<string, unknown>) => string
  readonly text: string
  /** 该思考块的翻译记录；缺省表示无需展示翻译入口。 */
  readonly translationRecord?: SessionTranslationRecord
  readonly running: boolean
  readonly hidden: boolean
  readonly reveal: () => void
  readonly useGroupAction?: (hidden: boolean, reveal: () => void) => React.RefObject<HTMLDivElement>
  readonly renderFactorySlot?: TranslationFactorySlot
  readonly markdownLabels: MarkdownTranslationLabels
  readonly pathImages: { resolve(value: string): string | undefined }
  readonly mentions?: unknown
}

function AssistantReasoningBlock(props: AssistantReasoningBlockProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const groupRef = props.useGroupAction?.(props.hidden, props.reveal)
  const displayText = props.translationRecord?.translated ?? props.text
  const summary = displayText.split('\n').map((line) => line.replace(/[`*_#>]/gu, '').trim()).find(Boolean) ?? ''
  return createElement('div', {
    ref: groupRef,
    hidden: props.hidden,
    'data-turn-process-inline': props.hidden || undefined,
  },
  createElement(DisclosureRow, {
    icon: createElement(IconThinkOutlineRegular, { size: 14 }),
    title: props.chatT('message.think'),
    open: expanded,
    expandable: true,
    expandOnRowClick: true,
    running: props.running,
    onToggle: () => setExpanded((value) => !value),
    collapsedContent: createElement('span', {
      style: { minWidth: 0, overflow: 'hidden', color: dshThemeColor.labelSecondary, fontSize: 'var(--dsh-content-font-size-secondary, 13px)', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, createElement(TextShimmer, { active: props.running, children: summary })),
  }, expanded ? createElement(AssistantReasoningContent, {
    messageId: props.messageId,
    services: props.services,
    translationT: props.translationT,
    text: props.text,
    running: props.running,
    ...(props.translationRecord === undefined ? {} : { translationRecord: props.translationRecord }),
    markdownLabels: props.markdownLabels,
    pathImages: props.pathImages,
    mentions: props.mentions,
    ...(props.renderFactorySlot === undefined ? {} : { renderFactorySlot: props.renderFactorySlot }),
  }) : null),
  )
}

interface AssistantReasoningContentProps {
  readonly messageId: string
  readonly services: CodingNsClientServices
  readonly translationT: CodingNsTranslator
  readonly text: string
  readonly running: boolean
  /** 该思考块的翻译记录；缺省表示无需展示翻译入口。 */
  readonly translationRecord?: SessionTranslationRecord
  readonly markdownLabels: MarkdownTranslationLabels
  readonly pathImages: { resolve(value: string): string | undefined }
  readonly mentions?: unknown
  /** DSH 的表现层工厂渲染入口；缺省时直接渲染原生 MarkdownText。 */
  readonly renderFactorySlot?: TranslationFactorySlot
}

/**
 * 思考块展开后的正文。
 *
 * DSH 原生 `ReasoningRow` 直接渲染 `MarkdownText`，运行时**没有**注册
 * `conversation.chat.reasoning.content` 工厂（`conversation.chat.*` 只有
 * `node` / `assistant-actions` / `commandview` / `turnTail`）。而 `renderFactorySlot`
 * 在工厂缺失时只渲染 `fallback`，缺省为 `null`——此前这里既不传 fallback，
 * 又把正文完全交给该工厂，于是展开思考后只剩翻译入口，译文一行都看不到。
 * 因此原生 MarkdownText 必须作为 fallback 传进去：没有工厂时按原生方式渲染，
 * 工厂存在时才允许表现层覆盖。
 */
export function AssistantReasoningContent(props: AssistantReasoningContentProps): ReactElement {
  const displayText = props.translationRecord?.translated ?? props.text
  const markdown = createElement(MarkdownText, { text: displayText, streaming: props.running, labels: props.markdownLabels, fileMentions: props.mentions as never, pathImages: props.pathImages, variant: 'compact' })
  const content = props.renderFactorySlot === undefined
    ? markdown
    : props.renderFactorySlot('conversation.chat.reasoning.content', { text: displayText, running: props.running }, { fallback: markdown })
  return createElement('div', {
    'data-codingns-translation-inline': true,
    style: { paddingTop: 8 },
  },
  content,
  props.translationRecord === undefined ? null : createElement(TranslationAction, {
    messageId: props.messageId,
    messageRole: 'assistant',
    services: props.services,
    translationT: props.translationT,
    record: props.translationRecord,
    inline: true,
  }),
  )
}

function createMarkdownLabels(chatT: (key: string) => string): MarkdownTranslationLabels {
  return {
    code: {
      copyLabel: chatT('copy'),
      copiedLabel: chatT('copied'),
      toolbarLabels: {
        codeLabel: chatT('codeBlock.title'),
        wrapLabel: chatT('codeBlock.wrap'),
        unwrapLabel: chatT('codeBlock.unwrap'),
      },
    },
    footnotes: chatT('markdown.footnotes'),
  }
}

function resolveMarkdownImagePath(value: string): string | undefined {
  if (typeof document === 'undefined' || !value.startsWith('/') || /^[/\\]{2}/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) return undefined
  const base = document.baseURI
  if (!/^https?:/u.test(base) && !base.startsWith('dsh-app://app/')) return undefined
  try {
    return new URL(`api/file?path=${encodeURIComponent(value)}`, base).href
  } catch {
    return undefined
  }
}

/**
 * 注册两个有实际翻译记录的消息渲染器；DSH 的用户气泡内容仍由统一主题令牌控制。
 */
export function registerSessionTranslationChatUi(services: CodingNsClientServices, facts: DshCapabilityRuntimeFacts = { primitives: messagePrimitives }): () => void {
  const resolution = createDshCapabilityRegistry(services.dshVersion, 'client', services, facts).getProfile(services).capabilities.get('conversation.message-presentation')
  const slots = services.slots as unknown as {
    inject?(key: string, callback: () => () => void): () => void
    register?(options: Record<string, unknown>, component: (props: any) => ReactElement | null): () => void
  } | undefined
  if (slots?.inject === undefined || slots.register === undefined) return () => undefined
  const removeStyles = installSessionTranslationChatStyles()
  const translationT = services.locale.bind('codingns')
  const removePendingActions = slots.inject('conversation.input.left', () => slots.register!({
    name: 'conversation.input.left',
    id: 'codingns-translation-pending',
    inject: (sessionId: string) => ({ services, sessionId, translationT }),
  }, PendingTranslationActions))
  if (resolution?.status !== 'ready') return () => { removePendingActions(); removeStyles() }
  const presentation = resolution.value as MessagePresentation
  const removeRenderers = presentation.mount(() => {
    const removeUserRenderer = slots.inject!('conversation.chat.node', () => slots.register!({
      name: 'conversation.chat.node',
      key: 'user',
      priority: -100,
      locale: 'chat',
      inject: (sessionId: string) => ({ services, sessionId, translationT }),
    }, props => UserMessageNodeView({ ...props, presentation })))
    let removeAssistantRenderer: () => void
    try {
      removeAssistantRenderer = slots.inject!('conversation.chat.node', () => slots.register!({
        name: 'conversation.chat.node',
        key: 'assistant-step',
        priority: -100,
        locale: 'chat',
        inject: (sessionId: string) => ({ services, sessionId, translationT }),
      }, props => AssistantTranslationNodeView({ ...props, presentation })))
    } catch (error) { removeUserRenderer(); throw error }
    return () => { removeAssistantRenderer(); removeUserRenderer() }
  })
  return () => {
    removePendingActions()
    removeRenderers()
    removeStyles()
  }
}

function installSessionTranslationChatStyles(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const styleId = 'codingns-session-translation-chat'
  if (document.head.querySelector(`style[data-plugin-css="${styleId}"]`) !== null) return () => undefined
  const style = document.createElement('style')
  style.dataset.plugin = 'codingns4dsh'
  style.dataset.pluginCss = styleId
  style.textContent = `
    @keyframes codingns-translation-spin{to{transform:rotate(360deg)}}
    [data-codingns-translation-pending]{animation:codingns-translation-spin .8s linear infinite}
    @media(prefers-reduced-motion:reduce){[data-codingns-translation-pending]{animation-duration:1.6s}}
    [data-codingns-translation-inline] > div:not([data-codingns-translation-action]){display:contents}
    [data-codingns-translation-inline] > div:not([data-codingns-translation-action]) > p:last-child{display:inline;margin:0}
  `
  document.head.appendChild(style)
  return () => style.remove()
}

function readEventSource(services: CodingNsClientServices, sessionId: string): EventSourceLike | undefined {
  const sessions = services.sessions as { binding?(id: string): { eventSource?: EventSourceLike } | undefined } | undefined
  try {
    return sessions?.binding?.(sessionId)?.eventSource
  } catch {
    return undefined
  }
}

function findTranslationRecordForText(
  snapshot: { readonly entries?: readonly unknown[] },
  text: string,
  outputKind?: SessionTranslationOutputKind,
  turn?: number,
  step?: number,
): SessionTranslationRecord | undefined {
  const entries = snapshot.entries ?? []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const event = readEntryEvent(entries[index])
    if (event === undefined || !event.type.startsWith('assistant/')) continue
    const eventData = asRecord(event.data)
    if (turn !== undefined && typeof eventData?.turn === 'number' && eventData.turn !== turn) continue
    if (step !== undefined && typeof eventData?.step === 'number' && eventData.step !== step) continue
    const candidates: unknown[] = []
    collectRecordCandidates(event.data, candidates, new Set<object>())
    for (const candidate of candidates) {
      const record = readRecord(candidate)
      if (record === undefined || record.original !== text && record.translated !== text) continue
      if (outputKind !== undefined && record.outputKind !== undefined && record.outputKind !== outputKind) continue
      return record
    }
  }
  return undefined
}

function collectRecordCandidates(value: unknown, candidates: unknown[], seen: Set<object>, depth = 0): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRecordCandidates(item, candidates, seen, depth + 1)
    return
  }
  const record = asRecord(value)
  if (record === undefined || seen.has(record) || depth > 7) return
  seen.add(record)
  if (readRecord(record) !== undefined || asRecord(record.codingnsTranslation) !== undefined) candidates.push(record)
  for (const key of ['codingnsTranslation', 'source', 'message', 'content', 'stream', 'chunk', 'block', 'data']) {
    if (record[key] !== undefined) collectRecordCandidates(record[key], candidates, seen, depth + 1)
  }
}

function readEntryEvent(value: unknown): Record<string, any> | undefined {
  const record = asRecord(value)
  const event = asRecord(record?.event)
  return event ?? (typeof record?.type === 'string' ? record : undefined)
}

function readRecord(value: unknown): SessionTranslationRecord | undefined {
  const record = asRecord(value)
  const candidate = asRecord(record?.codingnsTranslation) ?? record
  if (candidate?.original === undefined || candidate.translated === undefined) return undefined
  if (typeof candidate.original !== 'string' || typeof candidate.translated !== 'string') return undefined
  const targetLanguage = readLanguage(candidate.targetLanguage)
  if (targetLanguage === undefined) return undefined
  const model = readModel(candidate.model)
  const outputKind = candidate.outputKind === 'assistant' || candidate.outputKind === 'reasoning' ? candidate.outputKind : undefined
  return {
    original: candidate.original,
    translated: candidate.translated,
    ...(candidate.sourceLanguage === 'zh' || candidate.sourceLanguage === 'en' || candidate.sourceLanguage === 'fr' || candidate.sourceLanguage === 'de' || candidate.sourceLanguage === 'ja' ? { sourceLanguage: candidate.sourceLanguage } : {}),
    targetLanguage,
    bilingual: candidate.bilingual === true,
    ...(outputKind === undefined ? {} : { outputKind }),
    ...(candidate.alreadyTargetLanguage === true ? { alreadyTargetLanguage: true } : {}),
    ...(model === undefined ? {} : { model }),
    ...(candidate.failed === true ? { failed: true } : {}),
    ...readSessionTranslationMetrics(candidate),
  }
}

function readModel(value: unknown): SessionTranslationModel | undefined {
  const record = asRecord(value)
  if (typeof record?.provider !== 'string' || typeof record.model !== 'string' || record.provider.trim() === '' || record.model.trim() === '') return undefined
  return { provider: record.provider, model: record.model }
}

function readInputRecord(value: unknown): SessionTranslationInputRecord | undefined {
  const message = asRecord(value)
  const source = asRecord(message?.source)
  const candidate = asRecord(source?.codingnsTranslationInput)
  if (candidate?.original === undefined || candidate.translated === undefined) return undefined
  if (typeof candidate.original !== 'string' || typeof candidate.translated !== 'string') return undefined
  const targetLanguage = readLanguage(candidate.targetLanguage)
  if (targetLanguage === undefined) return undefined
  const model = readModel(candidate.model)
  return {
    original: candidate.original,
    translated: candidate.translated,
    ...(candidate.sourceLanguage === 'zh' || candidate.sourceLanguage === 'en' || candidate.sourceLanguage === 'fr' || candidate.sourceLanguage === 'de' || candidate.sourceLanguage === 'ja' ? { sourceLanguage: candidate.sourceLanguage } : {}),
    targetLanguage,
    ...(candidate.alreadyTargetLanguage === true ? { alreadyTargetLanguage: true } : {}),
    ...(model === undefined ? {} : { model }),
    ...(candidate.failed === true ? { failed: true } : {}),
    ...readSessionTranslationMetrics(candidate),
  }
}

function inputRecordForAction(record: SessionTranslationInputRecord): SessionTranslationRecord {
  return {
    original: record.original,
    translated: record.translated,
    ...(record.sourceLanguage === undefined ? {} : { sourceLanguage: record.sourceLanguage }),
    targetLanguage: record.targetLanguage,
    bilingual: false,
    ...(record.alreadyTargetLanguage === true ? { alreadyTargetLanguage: true } : {}),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.failed === true ? { failed: true } : {}),
    ...readSessionTranslationMetrics(record),
  }
}

function readLanguage(value: unknown): SessionTranslationLanguage | undefined {
  return value === 'zh' || value === 'en' || value === 'fr' || value === 'de' || value === 'ja' ? value : undefined
}

function formatModel(model: SessionTranslationModel | undefined, t: CodingNsTranslator): string {
  return model === undefined ? t('translation.modelUnknown') : `${model.provider} / ${model.model}`
}

function safeDomId(value: string): string {
  return encodeURIComponent(value).replace(/%/gu, '-')
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined
}
