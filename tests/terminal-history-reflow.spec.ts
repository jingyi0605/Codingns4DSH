import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('窗口列宽变化后重放 -J 合并后的历史，修复 tmux 历史行不重排', async () => {
  const source = await readFile(join(projectRoot, 'src/host/terminal/terminal-service.ts'), 'utf8')

  // tmux 只按新宽度渲染后续输出，不会重排已有内容；宽度变化后必须重新抓取
  // capture-pane -J 合并的长逻辑行并作为 snapshot 重放，否则历史行永远停在
  // 旧宽度、右侧留白。
  assert.match(source, /const widthChanged = record\.cols !== cols/u)
  // 行数的大幅变化（移动端虚拟键盘收放）同样会让 tmux 重绘可见区域，把旧列宽
  // 的历史物理行带回客户端、覆盖上一次重排；必须与宽度变化一样调度重排，让
  // 重排放置在最后一次屏幕重绘之后。±1 行的地址栏抖动不触发，避免频繁重置
  // 浏览位置。
  assert.match(source, /const rowsDelta = Math\.abs\(record\.rows - rows\)/u)
  assert.match(source, /if \(widthChanged \|\| rowsDelta >= TERMINAL_REFLOW_ROWS_THRESHOLD\) this\.scheduleHistoryReflow\(identity\)/u)
  assert.match(source, /TERMINAL_REFLOW_ROWS_THRESHOLD = 2/u)
  assert.match(source, /private async reflowHistory\(/u)
  assert.match(source, /pushSnapshot\(this\.info\(current, follower\.attachmentId\), captured\)/u)
  // 拖动窗口/软键盘动画会连续触发 resize，必须防抖合并成一次重放；防抖窗口同时
  // 决定 tmux 重绘旧列宽行到重放恢复之间的可见间隔，取值在合并与尽快恢复间折衷。
  assert.match(source, /HISTORY_REFLOW_DEBOUNCE_MS = 150/u)
  assert.match(source, /clearTimeout\(pending\)/u)
  // 服务卸载时清理待执行的重放，避免计时器泄漏。
  assert.match(source, /for \(const timer of this\.historyReflowTimers\.values\(\)\) clearTimeout\(timer\)/u)
})
