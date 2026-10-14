import { createElement, Fragment, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactElement } from 'react'
import {
  DshButton, DshCheckbox, DshInput, DshModal,
  resolveAssistantControlIcon, resolveDataIcon, resolvePlusIcon,
} from '../dsh-capabilities/client/primitives-adapter.js'
import type { AssistantChatCatalog } from '../shared/contracts/assistant.js'
import { isSessionTranslationAdapter } from '../shared/contracts/session-translation.js'
import type { SessionTranslationModel, SessionTranslationSettings } from '../shared/contracts/session-translation.js'
import type { CodingNsTranslator } from './locale.js'
import { uiFontSize } from './font-scale.js'
import { dshSettingsHelpStyle, dshThemeColor } from './theme.js'

interface ModelPoolProps {
  readonly value: SessionTranslationSettings
  readonly catalog: AssistantChatCatalog | null
  readonly disabled: boolean
  readonly pending: boolean
  readonly t: CodingNsTranslator
  readonly onChange: (models: readonly SessionTranslationModel[]) => Promise<boolean>
}

interface PoolDrag {
  readonly pointerId: number
  readonly key: string
  readonly startY: number
  readonly original: readonly SessionTranslationModel[]
  readonly order: readonly SessionTranslationModel[]
}

/** The persisted pool owns priority; modal choices and drag previews remain local until confirmed. */
export function SessionTranslationModelPool({ value, catalog, disabled, pending, t, onChange }: ModelPoolProps): ReactElement {
  const pool = value.translationModels ?? (value.translationModel === undefined ? [] : [value.translationModel])
  const available = new Map((catalog?.models ?? [])
    .filter((model) => !isSessionTranslationAdapter(model.provider))
    .map((model) => [modelKey(model), model]))
  const pooled = new Set(pool.map(modelKey))
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null)
  const [search, setSearch] = useState('')
  const [saveFailed, setSaveFailed] = useState(false)
  const [preview, setPreview] = useState<PoolDrag | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const drag = useRef<PoolDrag | null>(null)
  const list = useRef<HTMLOListElement>(null)
  const poolIdentity = JSON.stringify(pool)
  const pickerOpen = selection !== null
  const locked = disabled || pickerOpen

  const cancelDrag = (): void => { drag.current = null; setPreview(null) }
  useEffect(() => { cancelDrag() }, [disabled, poolIdentity])
  useEffect(() => { if (disabled && !pending) setSelection(null) }, [disabled, pending])

  const candidates = [...available.values()].filter((model) => !pooled.has(modelKey(model)))
  const query = search.trim().toLowerCase()
  const filtered = candidates.filter((model) => `${model.label} ${model.provider} ${model.model}`.toLowerCase().includes(query))
  const additions = [...selection ?? []].flatMap((key) => {
    const model = available.get(key)
    return model === undefined || pooled.has(key) ? [] : [{ provider: model.provider, model: model.model }]
  })
  const closePicker = (): void => { if (!pending) setSelection(null) }
  const addSelected = async (): Promise<void> => {
    if (disabled || additions.length === 0) return
    setSaveFailed(false)
    if (await onChange([...pool, ...additions])) setSelection(null)
    else setSaveFailed(true)
  }
  const commitOrder = (order: readonly SessionTranslationModel[], key: string): void => {
    if (locked) return
    void onChange(order).then((saved) => {
      if (saved) setAnnouncement(t('translation.modelReordered', {
        model: available.get(key)?.label ?? order.find((model) => modelKey(model) === key)?.model ?? '',
        priority: order.findIndex((model) => modelKey(model) === key) + 1,
      }))
    })
  }
  const startDrag = (event: PointerEvent<HTMLButtonElement>, key: string): void => {
    if (locked || pool.length < 2 || event.button !== 0 || list.current === null) return
    event.preventDefault()
    event.currentTarget.focus()
    // Capture on the stable list; the handle's row moves during the preview.
    list.current.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, key, startY: event.clientY, original: pool, order: pool }
  }
  const rowAtPointer = (event: PointerEvent<HTMLOListElement>): HTMLElement | undefined => {
    const target = event.currentTarget.ownerDocument.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-codingns-translation-model-key]')
    return target !== null && target !== undefined && list.current?.contains(target) ? target : undefined
  }
  const moveDrag = (event: PointerEvent<HTMLOListElement>): void => {
    const current = drag.current
    const root = list.current
    if (locked || current === null || current.pointerId !== event.pointerId || root === null) return
    if (preview === null && Math.abs(event.clientY - current.startY) < 4) return
    event.preventDefault()
    const rect = root.getBoundingClientRect()
    if (event.clientY < rect.top + 24) root.scrollTop -= 12
    else if (event.clientY > rect.bottom - 24) root.scrollTop += 12
    const target = rowAtPointer(event)
    if (target === undefined) return
    const targetIndex = current.order.findIndex((model) => modelKey(model) === target.dataset.codingnsTranslationModelKey)
    const sourceIndex = current.order.findIndex((model) => modelKey(model) === current.key)
    if (targetIndex < 0 || sourceIndex < 0 || targetIndex === sourceIndex) return
    const next = { ...current, order: moveModel(current.order, sourceIndex, targetIndex) }
    drag.current = next
    setPreview(next)
  }
  const finishDrag = (event: PointerEvent<HTMLOListElement>): void => {
    const current = drag.current
    if (current === null || current.pointerId !== event.pointerId) return
    cancelDrag()
    if (!locked && rowAtPointer(event) !== undefined && JSON.stringify(current.order) !== JSON.stringify(current.original)) commitOrder(current.order, current.key)
  }
  const keyboardMove = (event: KeyboardEvent<HTMLButtonElement>, key: string): void => {
    if (event.key === 'Escape' && drag.current !== null) { event.stopPropagation(); cancelDrag(); return }
    if (locked || drag.current !== null || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const index = pool.findIndex((model) => modelKey(model) === key)
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? pool.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1)
    if (index >= 0 && target >= 0 && target < pool.length && target !== index) commitOrder(moveModel(pool, index, target), key)
  }

  return createElement('div', { className: 'codingns-translation-pool', 'aria-busy': pending },
    createElement('style', null, modelPoolCss),
    createElement('div', { className: 'codingns-translation-pool-toolbar' },
      createElement('span', { style: dshSettingsHelpStyle }, t(pool.length === 0 ? 'translation.modelDefaultActive' : 'translation.modelPoolCount', { count: pool.length })),
      createElement(DshButton, { type: 'button', variant: 'outline', size: 'sm', disabled,
        icon: createElement(resolvePlusIcon(), { size: 14 }), 'aria-haspopup': 'dialog', 'aria-expanded': pickerOpen,
        onClick: () => { if (!disabled) { setSearch(''); setSaveFailed(false); setSelection(new Set()) } },
      }, t('translation.modelAdd')),
    ),
    pool.length === 0 ? createElement('div', { className: 'codingns-translation-pool-empty' },
      createElement(resolveDataIcon(), { size: 22 }),
      createElement('span', null, t('translation.modelPoolEmpty')),
    ) : createElement('ol', { ref: list, className: 'codingns-translation-pool-list', 'aria-label': t('translation.modelTitle'),
      onPointerMove: moveDrag, onPointerUp: finishDrag, onPointerCancel: cancelDrag, onLostPointerCapture: cancelDrag,
    },
      ...(preview?.order ?? pool).map((model, index) => {
        const key = modelKey(model)
        const entry = available.get(key)
        const label = entry?.label ?? `${model.provider} / ${model.model}`
        return createElement('li', { key, 'data-codingns-translation-model-key': key,
          className: `codingns-translation-pool-row${preview?.key === key ? ' is-dragging' : ''}` },
          createElement(DshButton, { type: 'button', size: 'sm', disabled: locked || pool.length < 2,
            className: 'codingns-translation-pool-handle', 'aria-label': t('translation.modelDrag', { model: label }),
            title: t('translation.modelDragHelp'), onPointerDown: (event) => startDrag(event, key),
            onKeyDown: (event) => keyboardMove(event, key),
          }, createElement(DragHandleIcon)),
          createElement('span', { className: 'codingns-translation-pool-priority', title: t('translation.modelPriority', { priority: index + 1 }) }, index + 1),
          createElement(ModelIdentity, { model, label, t }),
          catalog !== null && entry === undefined && createElement('span', { className: 'codingns-translation-pool-unavailable' }, t('translation.modelUnavailable')),
          createElement(DshButton, { type: 'button', size: 'sm', disabled: locked,
            className: 'codingns-translation-pool-remove', 'aria-label': t('translation.modelRemove', { model: label }),
            title: t('translation.modelRemove', { model: label }),
            onClick: () => { if (!locked) void onChange(pool.filter((item) => modelKey(item) !== key)) },
          }, createElement(resolveAssistantControlIcon('close'), { size: 14 })),
        )
      }),
    ),
    createElement('div', { className: 'codingns-translation-pool-toolbar' },
      createElement('span', { style: { ...dshSettingsHelpStyle, flex: 1 } }, t('translation.modelHelp')),
      pool.length > 0 && createElement(DshButton, { type: 'button', size: 'sm', disabled: locked,
        onClick: () => { if (!locked) void onChange([]) },
      }, t('translation.modelFollowDefault')),
    ),
    createElement('span', { role: 'status', 'aria-live': 'polite', className: 'codingns-translation-pool-status' }, announcement),
    createElement(DshModal, {
      open: pickerOpen, onClose: closePicker, title: t('translation.modelPickerTitle'), closeLabel: t('translation.modelCancel'),
      description: t('translation.modelPickerHelp'), className: 'codingns-translation-model-picker',
      contentClassName: 'codingns-translation-model-picker-content',
      footer: createElement(Fragment, null,
        createElement('span', { className: 'codingns-translation-picker-count', 'aria-live': 'polite', style: dshSettingsHelpStyle }, t('translation.modelPickerCount', { count: additions.length })),
        createElement(DshButton, { type: 'button', variant: 'outline', disabled: pending, onClick: closePicker }, t('translation.modelCancel')),
        createElement(DshButton, { type: 'button', variant: 'primary', disabled: disabled || additions.length === 0,
          onClick: () => { void addSelected() },
        }, t('translation.modelAddSelected', { count: additions.length })),
      ),
    },
      createElement('div', { className: 'codingns-translation-picker-body', 'aria-busy': pending },
        createElement(DshInput, { type: 'search', value: search, placeholder: t('translation.modelSearch'),
          'aria-label': t('translation.modelSearch'), ...{ 'data-modal-autofocus': true }, disabled,
          onChange: (event) => setSearch(event.currentTarget.value),
        }),
        createElement('div', { className: 'codingns-translation-picker-list', role: 'group', 'aria-label': t('translation.modelPickerTitle') },
          ...filtered.map((model) => {
            const key = modelKey(model)
            return createElement('div', { key, className: `codingns-translation-picker-choice${selection?.has(key) ? ' is-selected' : ''}` },
              createElement(DshCheckbox, { checked: selection?.has(key) === true, disabled, label: model.label,
                onChange: (checked) => {
                  if (disabled) return
                  setSelection((previous) => {
                    const next = new Set(previous)
                    if (checked) next.add(key)
                    else next.delete(key)
                    return next
                  })
                },
              }),
              createElement('span', { className: 'codingns-translation-picker-provider', style: dshSettingsHelpStyle }, t(isOfficialProvider(model.provider) ? 'translation.modelOfficial' : 'translation.modelThirdParty')),
            )
          }),
          filtered.length > 0 ? null : createElement('div', { className: 'codingns-translation-pool-empty', role: 'status' },
            t(catalog === null ? 'translation.modelLoading' : candidates.length > 0 ? 'translation.modelNoMatches' : available.size > 0 ? 'translation.modelAllAdded' : 'translation.modelEmpty')),
        ),
        saveFailed && createElement('span', { role: 'alert', style: { ...dshSettingsHelpStyle, color: dshThemeColor.error } }, t('translation.saveRejected')),
      ),
    ),

  )
}

function modelKey(model: SessionTranslationModel): string { return JSON.stringify([model.provider, model.model]) }

function moveModel(pool: readonly SessionTranslationModel[], source: number, target: number): readonly SessionTranslationModel[] {
  const next = [...pool]
  const model = next.splice(source, 1)[0]
  if (model !== undefined) next.splice(target, 0, model)
  return next
}

function isOfficialProvider(provider: string): boolean { return /^(?:deepseek(?:-official)?|official-deepseek)$/iu.test(provider.trim()) }

function ModelIdentity({ model, label, t }: { readonly model: SessionTranslationModel; readonly label: string; readonly t: CodingNsTranslator }): ReactElement {
  const [provider, ...name] = label.split(' / ')
  return createElement('div', { className: 'codingns-translation-pool-identity', title: label },
    createElement('span', { className: 'codingns-translation-pool-name' }, name.join(' / ') || model.model),
    createElement('span', { style: dshSettingsHelpStyle }, `${provider ?? model.provider} · ${t(isOfficialProvider(model.provider) ? 'translation.modelOfficial' : 'translation.modelThirdParty')}`),
  )
}

function DragHandleIcon(): ReactElement {
  return createElement('svg', { width: 14, height: 18, viewBox: '0 0 14 18', fill: 'currentColor', 'aria-hidden': true, focusable: false },
    ...[5, 9].flatMap((cx) => [4, 9, 14].map((cy) => createElement('circle', { key: `${cx}:${cy}`, cx, cy, r: 1 }))),
  )
}

const modelPoolCss = `
.codingns-translation-pool{display:grid;gap:10px;min-width:0}
.codingns-translation-pool-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.codingns-translation-pool-list{list-style:none;margin:0;padding:0;max-height:352px;overflow:auto;overscroll-behavior:contain;border:.5px solid ${dshThemeColor.menuBorder};border-radius:var(--dsw-radius-md,12px);background:${dshThemeColor.pageBackground}}
.codingns-translation-pool-row{display:flex;align-items:center;gap:10px;min-height:64px;padding:8px 12px 8px 6px;box-sizing:border-box}
.codingns-translation-pool-row:not(:last-child){border-bottom:.5px solid ${dshThemeColor.menuBorder}}
.codingns-translation-pool-row:hover{background:${dshThemeColor.hoverBackground}}
.codingns-translation-pool-row.is-dragging{background:${dshThemeColor.activeBackground};box-shadow:inset 2px 0 ${dshThemeColor.accent}}
.codingns-translation-pool .codingns-translation-pool-handle{width:28px;flex:0 0 28px;padding:0;touch-action:none;cursor:grab;color:${dshThemeColor.labelTertiary}}
.codingns-translation-pool .codingns-translation-pool-handle:active{cursor:grabbing}
.codingns-translation-pool .codingns-translation-pool-handle:disabled{cursor:default}
.codingns-translation-pool-priority{display:flex;align-items:center;justify-content:center;flex:0 0 24px;height:24px;border-radius:var(--dsw-radius-sm,8px);background:${dshThemeColor.surfaceSubtle};color:${dshThemeColor.labelSecondary};font-size:${uiFontSize(12)};font-variant-numeric:tabular-nums}
.codingns-translation-pool-identity{display:grid;gap:2px;min-width:0;flex:1}
.codingns-translation-pool-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${dshThemeColor.labelPrimary};font-size:${uiFontSize(13)};font-weight:500;line-height:20px}
.codingns-translation-pool-identity>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.codingns-translation-pool .codingns-translation-pool-remove{flex:0 0 28px;width:28px;padding:0;color:${dshThemeColor.labelTertiary}}
.codingns-translation-pool-unavailable{max-width:110px;flex-shrink:0;color:${dshThemeColor.warning};font-size:${uiFontSize(11)};line-height:16px}
.codingns-translation-pool-empty{display:flex;align-items:center;justify-content:center;gap:10px;padding:22px 14px;color:${dshThemeColor.labelTertiary};background:${dshThemeColor.surfaceSubtle};border-radius:var(--dsw-radius-md,12px);font-size:${uiFontSize(12)};text-align:center;line-height:20px}
.codingns-translation-pool-status{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.codingns-translation-model-picker{width:min(520px,100%);max-height:100%;color:${dshThemeColor.labelPrimary}}
.codingns-translation-model-picker-content{min-height:0;overflow:auto}
.codingns-translation-picker-body{display:grid;gap:12px;padding-bottom:4px}
.codingns-translation-picker-list{display:grid;gap:6px;min-height:80px;max-height:320px;overflow:auto;overscroll-behavior:contain}
.codingns-translation-picker-choice{display:grid;gap:3px;padding:10px 12px;border:.5px solid ${dshThemeColor.menuBorder};border-radius:var(--dsw-radius-sm,8px);background:${dshThemeColor.pageBackground}}
.codingns-translation-picker-choice:hover,.codingns-translation-picker-choice.is-selected{background:${dshThemeColor.hoverBackground}}
.codingns-translation-picker-choice>label{align-items:flex-start;gap:10px;overflow-wrap:anywhere}
.codingns-translation-picker-choice input{margin-top:2px}
.codingns-translation-picker-provider{padding-left:26px}
.codingns-translation-picker-count{margin-right:auto}
@media(max-width:480px){.codingns-translation-pool-row{gap:6px;padding-right:8px}.codingns-translation-pool-unavailable{max-width:70px}.codingns-translation-picker-choice{padding:10px}}
`
