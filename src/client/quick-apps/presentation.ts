import type { CSSProperties } from 'react'
import type { QuickApp } from '../../shared/contracts/quick-apps.js'

export type QuickAppDraft = Omit<QuickApp, 'revision'> & { expectedRevision: number }

export function newQuickAppDraft(order: number): QuickAppDraft {
  return { id: '', title: '', hostId: 'local', workspaceId: '', entryPath: '', documentRoot: '', kind: 'html', fileAccess: 'workspace', spaFallback: false, mounts: [], order, expectedRevision: 0 }
}

export function entryTitle(path: string): string {
  const parts = path.trim().split('/').filter(Boolean)
  const name = parts.at(-1)?.replace(/\.[^.]+$/u, '') ?? ''
  return name.toLowerCase() === 'index' ? parts.at(-2) ?? name : name
}

export function draftChanged(draft: QuickAppDraft, app: QuickApp): boolean {
  return (Object.keys(newQuickAppDraft(0)) as (keyof QuickAppDraft)[]).some(key =>
    key !== 'expectedRevision' && JSON.stringify(draft[key]) !== JSON.stringify(app[key]))
}

/** Match the parent workspace shortcut rail's stable, name-based icon treatment. */
export function shortcutIcon(app: Pick<QuickApp, 'title' | 'entryPath' | 'kind'>): { text: string; style: CSSProperties } {
  const label = app.title.trim() || entryTitle(app.entryPath)
  const cjk = Array.from(label).filter(char => /[㐀-鿿]/u.test(char))
  const initials = label.split(/[\s\-_/]+/u).filter(Boolean).map(word => Array.from(word)[0]).join('')
  const text = cjk.length ? cjk.slice(0, 2).join('') : Array.from(initials || label).slice(0, 2).join('').toUpperCase()
  let hash = 0
  for (const char of `${label}|${app.entryPath}|${app.kind}`) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0
  const hue = Math.abs(hash) % 360
  return { text, style: { background: `linear-gradient(135deg, hsl(${hue} 82% 91%), hsl(${(hue + 28) % 360} 78% 85%))`, color: `hsl(${hue} 46% 20%)` } }
}
