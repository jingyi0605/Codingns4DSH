# Codex 完全访问并保留危险操作确认：Stage0 验收

日期：2026-11-21，新加坡时间。分支：`feat/codex-full-access-confirm`，基于 `main` 的 `cc02a733`。

## 1. 结论与边界

真实 Windows Stage0、浏览器和 Codex 验收通过。选择「完全访问，危险操作需确认」后，危险 PowerShell 命令会进入 DSH 原生审批；审批前文件保持存在，批准后删除，拒绝和取消后保留。同一 Codex 会话连续执行三种情况，重启 Stage0 后还能恢复原模式和 Provider 会话，并再次完成审批。

本次用户明确授权配置 Stage0、构建和运行验收。仅使用独立 Stage0 目录和专用测试文件，没有更新正式 Desktop、改写主工作区 `data/build/dist/` 或修改依赖与锁文件。正式服务仍在 `127.0.0.1:17890`，进程为 2052。

## 2. 环境

| 项目 | 本次取值 |
| --- | --- |
| Stage0 根目录 | `C:/Users/Administrator/.dsh-stage0-codex-confirm` |
| 隔离源码和构建目录 | 上述目录的 `checkout/`，复制当前已跟踪及未提交源码，依赖以 junction 只读复用主仓库 `node_modules/` |
| 独立运行时 | `runtime/node_modules/@deepseek-ai/dsh`，安装 npm 发布版 `0.2.2-rc.5` |
| Node / Codex | Node `24.19.0` / Codex CLI `0.169.1` |
| 模型 | 既有 Codex 登录配置中的 `hl/gpt-6.1-sol`，medium |
| DSH Home / 状态 | `home/` / `state/`，独立 `stage0` Profile |
| Web 地址 | `http://127.0.0.1:17896/`，仅监听回环地址 |
| 验收会话 | `session-0f033bbb-8fb7-49d9-834f-a58e2252c9e8` |
| Codex Provider 会话 | `01a1fe95-7850-7cf3-8558-4c6297455c07` |
| 工作区 | `workspace/approval-test/`，界面名称「Codex危险操作确认验收」 |
| 会话名称 | 「Codex危险操作确认：批准、拒绝、取消」 |

没有复制或修改 Codex 凭据和原有会话；真实 CLI 仅为本次验收建立新的 Provider 会话。Profile 的 Codex 选择使用既有模型服务。

## 3. 实测结果

| 检查 | 实际观察 |
| --- | --- |
| 模式选择 | 真实菜单显示新模式；启用按钮在勾选风险确认前禁用，勾选并确认后保存成功 |
| 从旧完全访问切换 | DSH 初始使用 `danger-full-access + never`；新回合通过原生 setter 恢复 `ask`，权限投影变为 `custom`，插件仍显示所选模式 |
| 批准 | `approve-canary.txt` 在审批前存在；点击「允许一次」后删除，回合正常结束 |
| 拒绝 | `reject-canary.txt` 在审批前后均存在；点击「拒绝」后回合结束，没有更换工具或重试删除 |
| 取消 | `cancel-canary.txt` 在审批前后均存在；原生 `session/cancel` 关闭审批并结束回合 |
| 原生审计 | DSH 的前三个 `approval/decided` 依次为 `allowed-once`、`rejected`、`cancelled` |
| Codex 实际权限 | 三个 `turn_context` 均为 `sandbox_policy.type=danger-full-access`、`approval_policy=on-request`、`approvals_reviewer=user` |
| 第一次重启 | 同一 DSH 会话恢复 `full-access-confirm` 和原 Provider ID；浏览器打开原会话显示新模式 |
| 实际设置持久化 | 在浏览器从新模式切到人工审批，再勾选切回；Profile 实际写入会话模式和 Agent 偏好 |
| 重启后审批 | 续接原 Provider 会话，`restart-canary.txt` 等待审批，点击批准后删除；原生审计追加第四项 `allowed-once` |
| 第二次重启 | 实际保存的模式、Provider ID 和四项原生审计均恢复，浏览器显示正确模式 |
| 入口 | 无 cookie 访问返回 401；当前登录入口返回 303；携带获得的 cookie 访问首页返回 200 |

被测命令均为 `Remove-Item -LiteralPath '<专用文件>' -Force -ErrorAction Stop`，由真实 Codex 的 `exec_command` 经 PowerShell 7 执行；不依赖假进程或替代删除 API。

## 4. 环境问题与修正

初版 Stage0 把插件配置放在 `--patch` 命令行覆盖层。界面和执行在内存中正常，但 DSH ConfigEditor 拒绝持久化，日志报告 `Configuration for "@jingyi0605/codingns4dsh" is overridden by a home patch or command-line overlay`。

将插件登记和设置移动到隔离的 `home/profiles/stage0/cordis.patch.yml`，命令行覆盖层只保留端口等固定环境设置。重启后通过真实界面保存、检查 Profile 写入并再次重启，确认持久化可用。最后一次启动日志 `artifacts/startup4.stderr.log` 为空。这是验收部署配置修正，未为此更改插件源码。

## 5. 验收时的本机证据

验收时 Stage0 根目录包含以下文件。用户确认验收通过后要求关闭并清理全部 Stage0，这些本机文件已随隔离环境删除；本节保留历史证据说明，不表示文件或入口仍可访问。

- `artifacts/build.log`：独立源码副本的 Host、Client、H5 构建结果，退出码 0。
- `artifacts/acceptance.json`：三个决定、重启恢复和实际持久化的汇总。
- `artifacts/dsh-approval-audit.json`：四项原生决定及相关回合审计。
- `artifacts/codex-permission-evidence.json`：首次三个回合的有效权限摘要。
- `artifacts/live-mode-menu.png`、`live-mode-confirmation.png`、`approve-waiting-approval.png`、`reject-waiting-approval.png`、`cancel-waiting-approval.png`、`restored-session-approval.png`、`final-cold-restored-session.png`：真实界面截图。
- `stage0-api.mjs`、`browser-helper.mjs`、`acceptance.mjs`、`verify-persistence.mjs`、`verify-cold.mjs`：本机验收脚本。初次执行脚本使用新建文件约束；重放前使用新的专用文件名，不覆盖原有文件。
- `start-stage0.ps1`：隐藏窗口启动器。`launcher.pid`、`active-startup-log.txt` 记录验收时的启动归属。
- `Stage0-危险操作确认验收.url`：验收时的登录快捷入口，仅保存在本机，未将登录 token 写入仓库。
- `workspace/approval-test/验收说明.md` 和 `manual-canary.txt`：手工验收说明与专用测试文件。

## 6. 验收后清理

用户已确认验收通过，并授权关闭和清理全部 Stage0、以中文提交改动并向上游发起 PR。检查用户目录、常用开发状态目录和相关进程后，仅发现本次 `~/.dsh-stage0-codex-confirm/` 环境。

- 已停止 Stage0 启动器、监督进程、DSH Worker 及其子进程；另外通过实际工作目录确认并关闭了四组脱离原父进程的 Stage0 Magpie 进程。这些进程曾占用隔离 `checkout/`，导致首次目录清理返回 Windows 文件占用错误。
- 先移除三个已核对目标的 junction，再删除隔离环境，包括其运行时、Home、状态、构建、截图、脚本、专用测试文件和登录快捷方式。主仓库 `node_modules/typescript/package.json` 仍可访问。
- 已删除本次浏览器夹具、基线回放和验收生成的 16 个临时目录及 6 个临时文件。
- `17896` 已无监听，旧验收链接失效；正式服务 `127.0.0.1:17890` 仍由原进程 2052 提供。

重新验收需要重新建立独立 Stage0，按本记录的版本、可写 Profile 配置和专用文件约束操作。已删除的本机脚本与截图不能作为可直接重放的附件。

未验证：正式 Desktop 安装后的交互、物理手机、macOS/Linux 实机。本记录的 Windows 真实 Stage0 不替代这些环境的验收。
