# Agent 原生审批模式

会话输入栏的权限入口按 Agent 展示原生能力，并继续使用 DSH 的 PermissionSelect 和风险确认组件。

| Agent | 模式 | 执行参数 |
| --- | --- | --- |
| Codex | 人工审批、自动审查、只读、完全访问 | 原有 sandbox/approvalPolicy；自动审查将 thread 和 turn 的 `approvalsReviewer` 设为 `auto_review`，其余模式恢复 `user` |
| ZCode | 人工审批、自主审批、规划、自动接受编辑、完全访问 | `build`、`guarded`、`plan`、`edit`、`yolo` |
| Antigravity | 默认、自动接受编辑、规划、完全访问 | `agy acp` 的 `default`、`accept-edits`、`plan`，以及启动开关 `--dangerously-skip-permissions` |

其他 Agent 保留 DSH 原有权限入口。新建普通 agy 会话从第一轮使用最近一次选定的模式。需要审批的模式在回合开始时将 DSH 的「完全权限」预设切到「工作区内修改」。

## 保存与回合边界

选择会保存到当前会话，并作为该 Agent 新建普通会话时的偏好。完全访问沿用 DSH 的勾选确认流程，确认文案说明记忆行为；自动审查也保留原生风险确认。Team/子会话不借用普通会话的全局权限偏好。

运行中或已有排队消息时仍可更改权限，但新设置只对下一轮生效。当前 Provider 回合、工具续段和同轮其他 Agent 输入使用启动时的权限快照；未知权限也必须保持未知。延迟返回的 Provider 身份绑定不会覆盖运行中刚保存的设置。保存失败时恢复之前的显示值。

旧 Codex/ZCode 会话没有显式原生模式，或保存了旧 `inherit` 值时，继续保留原有 DSH 权限。Antigravity 未选模式或保存了已移除的模式时使用 `default`。

## CLI 条件

Codex 自动审查要求 app-server 支持 `approvalsReviewer: auto_review`；本次从安装的 Codex 0.162.0 导出协议 schema，确认 thread/turn 参数支持该字段。ZCode 自主审批要求运行时支持 `guarded`。不支持这些原生能力的 CLI 应先升级或选用其支持的模式。

本机 agy 1.5.12 的 `session/new` 返回 `currentModeId: default`，以及 `default`、`accept-edits`、`plan` 三个可选模式。

## 验证与复现

使用 Node >=24.9，在完成项目安装和构建后运行：

```sh
node --import ./tests/register-css-loader.mjs --test --test-concurrency=1 \
  tests/native-approval-modes.spec.ts \
  tests/native-approval-next-turn.spec.ts \
  tests/native-approval-ui.spec.ts \
  tests/native-approval-zcode.spec.ts \
  tests/cli-adapters-codex-permissions.spec.ts \
  tests/cli-adapters-antigravity-permissions.spec.ts \
  tests/cli-adapters-zcode-interactions.spec.ts
```

浏览器用例需要已安装的 Chromium，以及本机 DSH 权限组件。可从 DSH Desktop 的 `app.asar` 只读提取测试组件；输出须为尚不存在的文件：

```sh
node tests/fixtures/extract-native-permission.mjs /path/to/app.asar /tmp/permission-test/native-permission.js
DSH_NATIVE_PERMISSION_SOURCE=/tmp/permission-test/native-permission.js \
QUICK_APPS_BROWSER_BIN=/path/to/chrome \
DSH_APPROVAL_ARTIFACTS=/tmp/permission-test/screenshots \
node --import ./tests/register-css-loader.mjs --test tests/native-approval-mobile-browser.spec.ts
```

Windows 在 PowerShell 中分别设置同名 `$env:` 变量。临时 bundle/profile 随 TEMP/TMP；设置它们可把全部中间产物放入指定测试目录。提取器适用于本次验证的 DSH 0.2.2-rc.3 权限组件；其他版本结构改变时会显式失败。

本次浏览器检查覆盖 320/360/390/430/768/1280 宽度的触摸菜单、运行中保存、排队中的 ZCode 设置、自动审查取消、完全访问勾选确认和 Antigravity 文案。截图来自真实组件与合成会话夹具，没有模型请求；不等于物理手机或已安装宿主的真实工具执行验收。

![360 像素下的 Codex 权限菜单](images/agent-permissions-menu-360.png)

![Antigravity 完全访问风险确认](images/agent-permissions-agy-confirm-360.png)
