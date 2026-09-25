import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('终端入口复用 DSH 内置按钮与菜单，不退回原生表单控件', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /Button,[\s\S]*IconChevronDownOutline14,[\s\S]*Menu,/u)
  assert.match(source, /variant: 'ghost'/u)
  assert.doesNotMatch(source, /createElement\(['"]select['"]/u)
  assert.doesNotMatch(source, /border:\s*['"]1px solid currentColor/u)
})

test('终端标题双击会进入编辑并阻止标签页父级事件吞掉交互', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /onDoubleClick:[ \t]*beginEditing/u)
  assert.match(source, /onClick:[ \t]*beginEditing/u)
  assert.match(source, /event\.detail\s*===\s*undefined\s*\|\|\s*event\.detail\s*>=\s*2/u)
  assert.match(source, /onPointerDown:[ \t]*stopPropagation/u)
})

test('消息列表会话头部不再显示终端恢复按钮', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')
  assert.doesNotMatch(source, /conversation\.session\.header\.actions/u)
  assert.doesNotMatch(source, /TerminalRecovery/u)
})

test('终端布局和 xterm 默认值与 DSH 0.1.6 内置终端一致', async () => {
  const [styles, xterm] = await Promise.all([
    readFile(join(projectRoot, 'src/client/terminal/styles.ts'), 'utf8'),
    readFile(join(projectRoot, 'src/client/terminal/xterm-view.ts'), 'utf8'),
  ])

  assert.match(styles, /border-radius:24px/u)
  assert.match(styles, /padding:8px/u)
  assert.match(styles, /--dsw-alias-bg-base/u)
  assert.match(styles, /--dsw-alias-label-primary/u)
  assert.match(xterm, /minimumContrastRatio:\s*4\.5/u)
  assert.match(xterm, /fontSize:\s*appearance\.fontSize \?\? 13/u)
  assert.match(xterm, /ui-monospace, SFMono-Regular, Menlo, Consolas, monospace/u)
})

test('xterm 不会用 Shell 默认标题覆盖调试终端标题', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/xterm-view.ts'), 'utf8')

  assert.match(source, /preserveHostTitle/u)
  assert.match(source, /state\.info\.title !== state\.info\.shell\.name/u)
  assert.match(source, /if \(!preserveHostTitle\) void view\.rename\(value\)/u)
})
