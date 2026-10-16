import { createElement, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import type { CliManagementOperation } from '../shared/contracts/cli-management.js'
import type { CodingNsTranslator } from './locale.js'
import { uiFontSize } from './font-scale.js'
import { dshThemeColor } from './theme.js'

/** Follow new output until the user scrolls up to inspect earlier lines. */
export function CliManagementTerminal({ operation, t }: {
  readonly operation: CliManagementOperation
  readonly t: CodingNsTranslator
}): ReactElement {
  const viewport = useRef<HTMLPreElement>(null)
  const follow = useRef(true)
  const [following, setFollowing] = useState(true)
  useLayoutEffect(() => { follow.current = true; setFollowing(true) }, [operation.id])
  useLayoutEffect(() => {
    if (follow.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [operation.id, operation.output])
  const color = operation.state === 'succeeded' ? '#86efac' : operation.state === 'failed' ? '#fda4af' : operation.state === 'cancelled' ? '#fcd34d' : '#93c5fd'
  return createElement('section', { 'aria-label': t('cli.manage.output'), style: { minWidth: 0, overflow: 'hidden', borderRadius: 10, border: '1px solid #263244', background: '#0b1220', color: '#e2e8f0' } },
    createElement('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: '9px 12px', background: '#131e30', borderBottom: '1px solid #263244', fontSize: uiFontSize(11) } },
      createElement('span', { 'aria-hidden': true, style: { color: '#94a3b8', fontFamily: dshThemeColor.codeFont } }, '>_'),
      createElement('span', { style: { flex: 1 } }, t('cli.manage.output')),
      !following && createElement('button', { type: 'button', onClick: () => {
        follow.current = true; setFollowing(true)
        if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
      }, style: { border: '1px solid #475569', borderRadius: 5, padding: '4px 8px', background: 'transparent', color: '#e2e8f0', cursor: 'pointer', font: 'inherit', minHeight: 32 } }, t('cli.manage.latestOutput')),
      createElement('span', { style: { color, display: 'inline-flex', gap: 5, alignItems: 'center' } },
        createElement('span', { 'aria-hidden': true, style: { width: 6, height: 6, borderRadius: '50%', background: color } }),
        t(`cli.manage.log.${operation.state}`)),
    ),
    createElement('pre', {
      ref: viewport, role: 'log', 'aria-label': t('cli.manage.output'), 'aria-live': 'off', tabIndex: 0,
      onScroll: (event: { currentTarget: HTMLPreElement }) => {
        const node = event.currentTarget
        follow.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 24
        setFollowing(follow.current)
      },
      style: { boxSizing: 'border-box', margin: 0, padding: '12px 14px', height: 'clamp(140px, 32dvh, 300px)', overflow: 'auto', overscrollBehavior: 'contain', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: dshThemeColor.codeFont, fontSize: uiFontSize(12), lineHeight: 1.65, tabSize: 2 },
    }, operation.output || t(operation.state === 'running' ? 'cli.manage.waitingOutput' : 'cli.manage.emptyOutput')),
  )
}
