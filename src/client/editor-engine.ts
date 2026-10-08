import { basicSetup, EditorView } from 'codemirror'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'

/** 叶子引擎只依赖 CodeMirror；预览控制器在用户点击编辑后才加载本模块。 */
export function createFileEditor(parent: HTMLElement, content: string, path: string): EditorView {
  const language = editorLanguageForPath(path)
  const extensions = [basicSetup, editorTheme, EditorView.lineWrapping]
  if (language !== undefined) extensions.push(language)
  return new EditorView({ doc: content, extensions, parent })
}

// 编辑器只覆盖文件预览区域，颜色使用 DSH 主题变量。
const editorTheme = EditorView.theme({
  '&': { height: '100%', minHeight: '360px', color: 'var(--dsw-alias-label-primary, inherit)', backgroundColor: 'var(--dsw-alias-bg-layer-1, transparent)', fontSize: '13px' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', lineHeight: '1.55' },
  '.cm-content': { padding: '16px 0' },
  '.cm-line': { padding: '0 16px' },
  '.cm-gutters': { padding: '16px 0', backgroundColor: 'var(--dsw-alias-bg-layer-2, transparent)', color: 'var(--dsw-alias-label-tertiary, #8a8f98)', borderRight: '1px solid var(--dsw-alias-border-l2, #666)' },
  '.cm-gutterElement': { minWidth: '2.5em', padding: '0 10px 0 8px' },
  '.cm-activeLine': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--dsw-alias-interactive-bg-selected, rgba(80,120,200,.28)) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--dsw-alias-label-primary, currentColor)' },
})

function editorLanguageForPath(path: string) {
  const extension = path.toLowerCase().split(/[\\/.]/u).pop() ?? ''
  if (extension === 'md' || extension === 'markdown') return markdown()
  if (extension === 'json') return json()
  if (['js', 'jsx', 'mjs', 'cjs'].includes(extension)) return javascript({ jsx: extension === 'jsx' })
  if (['ts', 'tsx', 'mts', 'cts'].includes(extension)) return javascript({ jsx: extension === 'tsx', typescript: true })
  if (['html', 'htm', 'xml'].includes(extension)) return html()
  if (extension === 'css') return css()
  if (extension === 'py') return python()
  if (extension === 'sql') return sql()
  return undefined
}
