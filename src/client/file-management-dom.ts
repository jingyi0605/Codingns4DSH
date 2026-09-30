import type { CodingNsRpcClient } from './features/types.js'
import { callCodingNsRpc } from './settings-bridge.js'
import { basicSetup, EditorView } from 'codemirror'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { isOutsideDismissRoots } from './popup-dismiss.js'
import { resolveCodingNsTranslator, type CodingNsLocale } from './locale.js'

type FileEntryElement = HTMLElement & { dataset: DOMStringMap }
type ClipboardState = { mode: 'copy' | 'cut'; paths: string[] }
type FileEditorState = { root: HTMLElement; body: HTMLElement; host: HTMLElement; view: EditorView; path: FileTarget; buttons: HTMLElement }
type FileTarget = { path: string; sessionId?: string }

/** 可直接交给文本编辑器的扩展名；未知扩展名仍按只读预览处理，避免误打开二进制文件。 */
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.rst', '.adoc',
  '.ini', '.cfg', '.conf', '.config', '.properties', '.env', '.envrc', '.toml', '.yaml', '.yml', '.json', '.jsonc', '.json5', '.xml', '.csv', '.tsv',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.xhtml',
  '.sh', '.bash', '.zsh', '.fish', '.ksh', '.csh', '.ps1', '.psm1', '.bat', '.cmd',
  '.py', '.pyw', '.rb', '.rake', '.pl', '.pm', '.lua', '.php',
  '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.dart', '.cs', '.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx',
  '.sql', '.graphql', '.gql', '.proto',
  '.gitignore', '.gitattributes', '.gitmodules', '.npmrc', '.yarnrc', '.editorconfig', '.prettierrc', '.eslintrc', '.stylelintrc',
  '.lock',
])

/** 没有扩展名但内容通常是文本的常见工程文件名。 */
const TEXT_FILE_NAMES = new Set([
  '.env', '.envrc', '.gitignore', '.gitattributes', '.gitmodules', '.npmrc', '.yarnrc', '.editorconfig', '.prettierrc', '.eslintrc', '.stylelintrc',
  'dockerfile', 'makefile', 'cmakelists.txt', 'jenkinsfile', 'rakefile', 'gemfile', 'license', 'readme',
])

export interface FileManagementDomOptions {
  readonly menuEnhancement: boolean
  readonly fileEditor: boolean
  /** DSH 语言运行时；右键菜单、原生对话框和编辑按钮文案都从它取词。 */
  readonly locale?: CodingNsLocale
}

export interface FileManagementDomController {
  setOptions(options: FileManagementDomOptions): void
  dispose(): void
}

/** 给 DSH 原生文件树和文本查看器补充文件操作，不接管 DSH 自己的渲染状态。 */
export function startFileManagementDom(rpc: CodingNsRpcClient, initialOptions: FileManagementDomOptions): FileManagementDomController {
  // Client 功能也会在 H5/非浏览器测试环境被装配；没有 DOM 时保持惰性空实现。
  if (typeof document === 'undefined') return { setOptions: () => undefined, dispose: () => undefined }

  let menu: HTMLElement | undefined
  let clipboard: ClipboardState | undefined
  let editor: FileEditorState | undefined
  let options = { ...initialOptions }
  let t = resolveCodingNsTranslator(initialOptions.locale)
  let disposed = false
  const observer = typeof MutationObserver === 'undefined'
    ? undefined
    : new MutationObserver(() => { if (!disposed && options.fileEditor) enhanceEditors() })

  const closeMenu = (): void => { menu?.remove(); menu = undefined }
  const onContextMenu = (event: MouseEvent): void => {
    if (!options.menuEnhancement) return
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-files-entry][data-files-path]')
    if (target == null) return
    event.preventDefault()
    event.stopPropagation()
    openMenu(target, event.clientX, event.clientY)
  }
  // 只关闭「点在外面」的情况：菜单项自身在 pointerdown 之后才收到 click，
  // 若无条件关闭会把菜单从 DOM 移除，菜单项的动作永远不会执行。
  const onDocumentPointerDown = (event: Event): void => {
    if (menu === undefined) return
    if (isOutsideDismissRoots(event.target, [menu])) closeMenu()
  }
  const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') closeMenu() }
  document.addEventListener('contextmenu', onContextMenu, true)
  document.addEventListener('pointerdown', onDocumentPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  observer?.observe(document.body, { childList: true, subtree: true })
  if (options.fileEditor) enhanceEditors()

  const dispose = (): void => {
    disposed = true
    closeMenu()
    clearEditorEnhancements()
    editor = undefined
    observer?.disconnect()
    document.removeEventListener('contextmenu', onContextMenu, true)
    document.removeEventListener('pointerdown', onDocumentPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
  }

  return {
    setOptions(nextOptions) {
      const previous = options
      options = { ...nextOptions }
      if (nextOptions.locale !== previous.locale) t = resolveCodingNsTranslator(nextOptions.locale)
      if (!options.menuEnhancement) closeMenu()
      if (!options.fileEditor) clearEditorEnhancements()
      else if (!previous.fileEditor) enhanceEditors()
    },
    dispose,
  }

  function openMenu(item: FileEntryElement, x: number, y: number): void {
    closeMenu()
    const path = item.dataset.filesPath ?? ''
    const kind = item.dataset.filesEntry === 'directory' ? 'directory' : 'file'
    if (path === '') return
    const base = kind === 'directory' ? path : parentPath(path)
    const panel = item.closest<HTMLElement>('[data-files-state="tree"]')
    const items: Array<{ label: string; disabled?: boolean; action: () => void | Promise<void> }> = [
      { label: t(kind === 'directory' ? 'fileMenu.expandFolder' : 'fileMenu.openFile'), action: () => clickEntry(item) },
      { label: t('fileMenu.download'), disabled: kind !== 'file', action: () => void downloadFile({ path }) },
      { label: t('fileMenu.newFile'), action: () => void createEntry(base, false) },
      { label: t('fileMenu.newDirectory'), action: () => void createEntry(base, true) },
      { label: t('fileMenu.rename'), action: () => void renameEntry(path) },
      { label: t('fileMenu.copy'), action: () => { clipboard = { mode: 'copy', paths: [path] } } },
      { label: t('fileMenu.cut'), action: () => { clipboard = { mode: 'cut', paths: [path] } } },
      { label: t('fileMenu.paste'), disabled: clipboard === undefined, action: () => void pasteEntry(base, panel) },
      { label: t('fileMenu.copyRelativePath'), action: () => void copyPath(item, false) },
      { label: t('fileMenu.copyAbsolutePath'), action: () => void copyPath(item, true) },
      { label: t('fileMenu.gitIgnore'), action: () => void runMutation('git-ignore', { paths: [path] }, panel) },
      { label: t('fileMenu.delete'), action: () => void deleteEntry(path, panel) },
    ]
    menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.style.cssText = 'position:fixed;z-index:2147483647;min-width:190px;padding:5px;background:var(--dsw-alias-bg-layer-3,#242526);border:1px solid var(--dsw-alias-border-l2,#666);border-radius:8px;box-shadow:0 8px 30px #0008;color:var(--dsw-alias-label-primary,#eee);font:13px var(--dsw-font,system-ui,sans-serif)'
    for (const item of items) {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.textContent = item.label
      button.disabled = item.disabled === true
      button.style.cssText = 'display:block;width:100%;padding:7px 10px;border:0;border-radius:4px;background:transparent;color:inherit;text-align:left;cursor:pointer;font:inherit'
      button.addEventListener('mouseenter', () => { if (!button.disabled) button.style.background = 'var(--dsw-alias-interactive-bg-hover,#3a3b3d)' })
      button.addEventListener('mouseleave', () => { button.style.background = 'transparent' })
      button.addEventListener('click', () => { closeMenu(); void item.action() })
      menu.append(button)
    }
    document.body.append(menu)
    const width = menu.offsetWidth || 190
    const height = menu.offsetHeight || 360
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`
  }

  function clickEntry(item: HTMLElement): void {
    ;(item.querySelector('button') ?? item).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }

  async function createEntry(base: string, directory: boolean): Promise<void> {
    const name = window.prompt(t(directory ? 'fileMenu.promptNewDirectory' : 'fileMenu.promptNewFile'), '')?.trim()
    if (!name) return
    await runMutation(directory ? 'create-directory' : 'create-file', { path: joinPath(base, name) }, null)
  }

  async function renameEntry(path: string): Promise<void> {
    const next = window.prompt(t('fileMenu.promptRename'), leaf(path))?.trim()
    if (!next || next === leaf(path)) return
    const destination = isAbsoluteLike(next) ? next : joinPath(parentPath(path), next)
    await runMutation('rename', { path, destination }, null)
  }

  async function pasteEntry(base: string, panel: HTMLElement | null): Promise<void> {
    if (clipboard === undefined) return
    await runMutation(clipboard.mode === 'copy' ? 'copy' : 'move', { paths: clipboard.paths, destination: base }, panel)
    if (clipboard.mode === 'cut') clipboard = undefined
  }

  async function deleteEntry(path: string, panel: HTMLElement | null): Promise<void> {
    if (!window.confirm(t('fileMenu.confirmDelete', { name: leaf(path) }))) return
    await runMutation('delete', { paths: [path] }, panel)
  }

  async function downloadFile(target: FileTarget): Promise<void> {
    try {
      const result = await call('download', target) as { contentBase64: string; fileName?: string; mimeType?: string }
      const blob = new Blob([decodeBase64(result.contentBase64)], { type: result.mimeType ?? 'application/octet-stream' })
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = result.fileName ?? leaf(target.path)
      document.body.append(link)
      link.click()
      link.remove()
      // 某些局域网浏览器在 click 返回后才开始消费 Blob URL，不能立即撤销。
      globalThis.setTimeout(() => URL.revokeObjectURL(link.href), 30_000)
    } catch (error) { showNotice(errorMessage(error)) }
  }

  async function copyPath(item: FileEntryElement, absolute: boolean): Promise<void> {
    const path = item.dataset.filesPath ?? ''
    const root = filesRootForEntry(item)
    const value = absolute ? absolutePath(path, root) : relativePath(path, root)
    try {
      await copyTextToClipboard(value)
      showNotice(t(absolute ? 'fileMenu.copiedAbsolutePath' : 'fileMenu.copiedRelativePath'))
    } catch { showNotice(t('fileMenu.copyPathFailed')) }
  }

  async function runMutation(action: string, payload: Record<string, unknown>, panel: HTMLElement | null): Promise<void> {
    try {
      await call(action, payload)
      refreshPanel(panel)
      showNotice(t('fileMenu.operationDone'))
    } catch (error) { showNotice(errorMessage(error)) }
  }

  function refreshPanel(panel: HTMLElement | null): void {
    const reload = panel?.querySelector<HTMLButtonElement>('[data-files-reload]')
      ?? findButton(panel, NATIVE_RELOAD_PATTERN)
      ?? findButton(document, NATIVE_RELOAD_PATTERN)
    if (reload !== null && reload !== undefined) reload.click()
  }

  function enhanceEditors(): void {
    if (!options.fileEditor) return
    for (const root of document.querySelectorAll<HTMLElement>('[data-document-preview]')) {
      if (root.dataset.fileManagementEditor === 'true') continue
      const url = root.getAttribute('data-textpreview-url') ?? ''
      if (root.getAttribute('data-textpreview-state') !== 'text' || !isEditableFile(url)) continue
      const header = root.querySelector<HTMLElement>('[data-textpreview-path]')?.parentElement
      if (header === null || header === undefined) continue
      const button = createEditorButton(root, 'edit', t('fileEditor.edit'))
      button.setAttribute('data-file-management-edit', 'true')
      button.addEventListener('click', () => void beginEdit(root, url, button))
      placeEditorButton(root, header, button)
      root.dataset.fileManagementEditor = 'true'
    }
  }

  async function beginEdit(root: HTMLElement, url: string, editButton: HTMLButtonElement): Promise<void> {
    if (!options.fileEditor) return
    if (editor !== undefined) cancelEdit()
    const target = parseFileTarget(url, root)
    if (target === undefined) { showNotice(t('fileMenu.unresolvedPath')); return }
    try {
      const result = await call('read', target) as { content: string }
      const body = root.querySelector<HTMLElement>('[data-textpreview-body]')
      if (body === null) return
      const host = document.createElement('div')
      host.setAttribute('data-file-management-editor', 'true')
      host.setAttribute('aria-label', t('fileEditor.editorLabel'))
      host.style.cssText = 'box-sizing:border-box;width:100%;height:100%;min-height:360px;border:1px solid var(--dsw-alias-border-l2,#666);border-radius:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-1,transparent)'
      body.style.display = 'none'
      body.parentElement?.append(host)
      const language = editorLanguageForPath(target.path)
      const extensions = [basicSetup, editorTheme]
      if (language !== undefined) extensions.push(language)
      extensions.push(EditorView.lineWrapping)
      const view = new EditorView({ doc: result.content, extensions, parent: host })
      view.focus()
      const buttons = document.createElement('span')
      buttons.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:auto'
      const save = createEditorButton(root, 'save', t('fileEditor.save'))
      const cancel = createEditorButton(root, 'cancel', t('fileEditor.cancel'))
      buttons.append(save, cancel)
      editButton.replaceWith(buttons)
      editor = { root, body, host, view, path: target, buttons }
      save.addEventListener('click', () => void saveEdit())
      cancel.addEventListener('click', () => cancelEdit())
    } catch (error) { showNotice(errorMessage(error)) }
  }

  async function saveEdit(): Promise<void> {
    if (editor === undefined) return
    try {
      await call('write', { ...editor.path, content: editor.view.state.doc.toString() })
      const reload = editor.root.querySelector<HTMLButtonElement>('[data-textpreview-tool="reload"]')
        ?? findButton(editor.root.parentElement, NATIVE_RELOAD_PATTERN)
        ?? findButton(document, NATIVE_RELOAD_PATTERN)
      cancelEdit()
      reload?.click()
      showNotice(t('fileEditor.saved'))
    } catch (error) { showNotice(errorMessage(error)) }
  }

  function cancelEdit(reenhance = true): void {
    if (editor === undefined) return
    editor.view.destroy()
    editor.host.remove()
    editor.body.style.display = ''
    editor.buttons.remove()
    editor.root.dataset.fileManagementEditor = ''
    editor = undefined
    if (reenhance && options.fileEditor) enhanceEditors()
  }

  function clearEditorEnhancements(): void {
    cancelEdit(false)
    for (const root of document.querySelectorAll<HTMLElement>('[data-document-preview]')) {
      root.querySelector('[data-file-management-edit]')?.remove()
      root.dataset.fileManagementEditor = ''
    }
  }

  async function call(action: string, payload: unknown): Promise<unknown> {
    return callCodingNsRpc(rpc, `fileManagement/${action}`, payload)
  }
}

function placeEditorButton(root: HTMLElement, header: HTMLElement, button: HTMLButtonElement): void {
  const openTarget = root.querySelector<HTMLElement>('[data-open-target="file"]')
  const actionRow = openTarget?.parentElement
  if (openTarget !== null && openTarget !== undefined && actionRow !== null && actionRow !== undefined && root.contains(openTarget)) {
    actionRow.style.display = 'flex'
    actionRow.style.alignItems = 'center'
    actionRow.style.flexShrink = '0'
    openTarget.style.marginLeft = 'auto'
    openTarget.style.flex = '0 0 auto'
    button.style.marginLeft = '8px'
    button.style.flex = '0 0 32px'
    actionRow.insertBefore(button, openTarget)
    return
  }
  header.append(button)
}

// 编辑器只覆盖文件预览区域，颜色使用 DSH 主题变量，避免切换深浅色时残留固定配色。
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: '360px',
    color: 'var(--dsw-alias-label-primary, inherit)',
    backgroundColor: 'var(--dsw-alias-bg-layer-1, transparent)',
    fontSize: '13px',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    lineHeight: '1.55',
  },
  '.cm-content': { padding: '16px 0' },
  '.cm-line': { padding: '0 16px' },
  '.cm-gutters': {
    padding: '16px 0',
    backgroundColor: 'var(--dsw-alias-bg-layer-2, transparent)',
    color: 'var(--dsw-alias-label-tertiary, #8a8f98)',
    borderRight: '1px solid var(--dsw-alias-border-l2, #666)',
  },
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
  if (extension === 'js' || extension === 'jsx' || extension === 'mjs' || extension === 'cjs') return javascript({ jsx: extension === 'jsx' })
  if (extension === 'ts' || extension === 'tsx' || extension === 'mts' || extension === 'cts') return javascript({ jsx: extension === 'tsx', typescript: true })
  if (extension === 'html' || extension === 'htm' || extension === 'xml') return html()
  if (extension === 'css') return css()
  if (extension === 'py') return python()
  if (extension === 'sql') return sql()
  return undefined
}

type EditorButtonIcon = 'edit' | 'save' | 'cancel'

function createEditorButton(root: HTMLElement, iconName: EditorButtonIcon, title: string): HTMLButtonElement {
  const reference = root.querySelector<HTMLButtonElement>('[data-textpreview-tool]')
  const button = reference === null
    ? document.createElement('button')
    : reference.cloneNode(false) as HTMLButtonElement
  button.type = 'button'
  button.textContent = ''
  button.title = title
  button.setAttribute('aria-label', title)
  button.removeAttribute('data-textpreview-tool')
  button.removeAttribute('disabled')
  button.setAttribute('data-file-management-toolbar-button', 'true')
  button.style.display = 'inline-flex'
  button.style.alignItems = 'center'
  button.style.justifyContent = 'center'
  button.style.boxSizing = 'border-box'
  button.style.width = '32px'
  button.style.minWidth = '32px'
  button.style.height = '32px'
  button.style.marginLeft = '0'
  button.style.padding = '0'
  button.append(createEditorIcon(iconName))
  if (reference === null) {
    button.style.border = '1px solid var(--dsw-alias-border-l2,#d1d5db)'
    button.style.borderRadius = '6px'
    button.style.background = 'var(--dsw-alias-bg-layer-1,transparent)'
    button.style.color = 'var(--dsw-alias-label-primary,inherit)'
    button.style.cursor = 'pointer'
    button.style.transition = 'background-color 120ms ease,border-color 120ms ease,color 120ms ease'
    button.addEventListener('mouseenter', () => {
      button.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))'
      button.style.borderColor = 'var(--dsw-alias-border-l1,#9ca3af)'
    })
    button.addEventListener('mouseleave', () => {
      button.style.background = 'var(--dsw-alias-bg-layer-1,transparent)'
      button.style.borderColor = 'var(--dsw-alias-border-l2,#d1d5db)'
    })
  }
  return button
}

function createEditorIcon(iconName: EditorButtonIcon): Element {
  const paths: Record<EditorButtonIcon, readonly string[]> = {
    edit: ['M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z', 'm15 5 4 4'],
    save: ['M15.2 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.8z', 'M14 3v4a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3', 'M6 21v-4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v4'],
    cancel: ['M18 6 6 18', 'm6 6 12 12'],
  }
  const createElementNS = typeof document.createElementNS === 'function'
    ? document.createElementNS.bind(document)
    : undefined
  if (createElementNS !== undefined) {
    const icon = createElementNS('http://www.w3.org/2000/svg', 'svg') as SVGSVGElement
    icon.setAttribute('width', '16')
    icon.setAttribute('height', '16')
    icon.setAttribute('viewBox', '0 0 24 24')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('stroke', 'currentColor')
    icon.setAttribute('stroke-width', '1.8')
    icon.setAttribute('stroke-linecap', 'round')
    icon.setAttribute('stroke-linejoin', 'round')
    icon.setAttribute('aria-hidden', 'true')
    for (const pathData of paths[iconName]) {
      const path = createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', pathData)
      icon.append(path)
    }
    return icon
  }
  const fallback = document.createElement('span')
  fallback.textContent = iconName === 'edit' ? '✎' : iconName === 'save' ? '▣' : '×'
  fallback.setAttribute('aria-hidden', 'true')
  fallback.style.fontSize = '16px'
  fallback.style.lineHeight = '1'
  return fallback
}

/**
 * DSH 原生“重新读取”按钮的兜底识别。
 *
 * 这里匹配的是宿主自己的界面文案，不是插件词典，因此只能按宿主实际渲染的
 * 中英文标签判断；用正则表达多语言匹配，避免把宿主文案当成插件词条。
 */
const NATIVE_RELOAD_PATTERN = /^(?:重新读取文件|重新读取)$/u

function findButton(root: ParentNode | null | undefined, pattern: RegExp): HTMLButtonElement | undefined {
  if (root === null || root === undefined) return undefined
  for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
    const label = button.getAttribute('aria-label')?.trim() || button.textContent?.trim() || ''
    if (pattern.test(label)) return button
  }
  return undefined
}

function parseFileTarget(url: string, root: HTMLElement): FileTarget | undefined {
  const match = /^dsh-resource:\/\/file\/session\/([^/]+)\/(.*)$/u.exec(url)
  if (match === null) return undefined
  const sessionId = decodeURIComponent(match[1] ?? '')
  const path = decodeURIComponent(match[2] ?? '')
  const workspaceRoot = root.closest('[data-sidebar-right-panel]')?.querySelector<HTMLElement>('[data-files-root]')?.getAttribute('data-files-root')
  return workspaceRoot === null || workspaceRoot === undefined || workspaceRoot === ''
    ? { sessionId, path }
    : { path: joinPath(workspaceRoot, path) }
}

function filesRootForEntry(item: Element): string | undefined {
  const tree = item.closest<HTMLElement>('[data-files-state="tree"]')
  const panelRoot = item.closest<HTMLElement>('[data-sidebar-right-panel]')?.querySelector<HTMLElement>('[data-files-root]')
  const value = tree?.getAttribute('data-files-root')?.trim() || panelRoot?.getAttribute('data-files-root')?.trim()
  return value === null || value === undefined || value.trim() === '' ? undefined : value.trim()
}

function isEditableFile(url: string): boolean {
  const path = decodeURIComponent((url.split(/[?#]/u)[0] ?? '').split('/').pop() ?? '')
  return isEditableFilePath(path)
}

/** 判断文件名是否应显示编辑入口；与资源 URL 解码分开，便于单元测试和复用。 */
export function isEditableFilePath(path: string): boolean {
  const fileName = path.split(/[\\/]/u).filter(Boolean).pop()?.toLowerCase() ?? ''
  if (fileName === '' || TEXT_FILE_NAMES.has(fileName) || fileName.startsWith('.env.')) return fileName !== ''
  const dot = fileName.lastIndexOf('.')
  return dot > 0 && TEXT_EXTENSIONS.has(fileName.slice(dot))
}

function parentPath(path: string): string { const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')); return index <= 0 ? path.slice(0, Math.max(index, 1)) : path.slice(0, index) }
function leaf(path: string): string { return path.split(/[\\/]/u).filter(Boolean).pop() ?? path }
function isAbsoluteLike(path: string): boolean { return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) }
function joinPath(base: string, child: string): string { const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'; return `${base.replace(/[\\/]$/u, '')}${separator}${child.replace(/^[\\/]+/u, '')}` }
function absolutePath(path: string, root: string | undefined): string {
  if (isAbsoluteLike(path) || root === undefined) return path
  return joinPath(root, path)
}
function relativePath(path: string, root?: string): string {
  const workspaceRoot = root ?? document.querySelector<HTMLElement>('[data-files-root]')?.getAttribute('data-files-root') ?? undefined
  if (workspaceRoot === undefined) return path
  const normalizedPath = path.replaceAll('\\', '/')
  const normalizedRoot = workspaceRoot.replace(/[\\/]$/u, '').replaceAll('\\', '/')
  if (normalizedPath === normalizedRoot) return '.'
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizedPath.slice(normalizedRoot.length + 1)
  return path
}
async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // HTTP 局域网页面可能没有 Clipboard 权限，继续使用兼容回退。
    }
  }
  if (copyTextWithExecCommand(text)) return
  throw new Error('浏览器不允许访问剪贴板')
}
function copyTextWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function' || document.body === null) return false
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.focus()
  textarea.select()
  try { return document.execCommand('copy') } catch { return false } finally { textarea.remove() }
}
function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function showNotice(message: string): void { const notice = document.createElement('div'); notice.textContent = message; notice.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);padding:8px 14px;border-radius:6px;background:#2d2f33;color:#fff;box-shadow:0 4px 18px #0008;font:13px system-ui'; document.body.append(notice); globalThis.setTimeout(() => notice.remove(), 2200) }
