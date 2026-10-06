<div align="center">

# CodingNS for DeepSeek Harness

**把外部 Agent CLI、持久终端、工作区调试和远程访问，装进 DSH 原生界面。**

[![npm version](https://img.shields.io/npm/v/%40jingyi0605%2Fcodingns4dsh?logo=npm)](https://www.npmjs.com/package/@jingyi0605/codingns4dsh)
[![DSH compatibility](https://img.shields.io/badge/DSH-0.2.1--alpha.1-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-3C873A?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/gpl-3.0.html)

**简体中文** · [English](README.en.md)

**当前版本 `@jingyi0605/codingns4dsh@0.2.1-beta.1`** · DSH **`>=0.2.0-rc.2 <=0.2.1-alpha.1`**（已验证 `0.2.1-alpha.1`）· Node **`>= 22.19`** · macOS / Linux / Windows

**[GitHub](https://github.com/jingyi0605/Codingns4DSH)** · **[npm](https://www.npmjs.com/package/@jingyi0605/codingns4dsh)** · **QQ 群 1092985965**

<p>
  <a href="#界面预览">界面预览</a> ·
  <a href="#这是什么">这是什么</a> ·
  <a href="#支持的外部-agent">外部 Agent</a> ·
  <a href="#功能详解">功能详解</a> ·
  <a href="#安装">安装</a> ·
  <a href="#首次使用">首次使用</a> ·
  <a href="#故障排查">故障排查</a> ·
  <a href="#开发">开发</a> ·
  <a href="#鸣谢">鸣谢</a> ·
  <a href="#许可证">许可证</a>
</p>

</div>

## 界面预览

<div align="center">
  <img width="100%" src="assets/screenshots/workspace-overview.jpg" alt="工作台与右侧 Git 面板">
</div>

CodingNS 工作台把会话、Agent 选择器与右侧 Git 面板放在同一界面中。

---

## 这是什么

**DSH（DeepSeek Harness）** 是一个编码 Agent 运行框架，由 CLI 和 Web 界面组成，在你的 Workspace 中运行 Agent 循环。

**Codingns4DSH 是一个 DSH 插件 Bundle**（Host 层 + 浏览器层），提供十一个模块，全部在 **设置 → Codingns4DSH** 中配置。

> 名称说明：本插件名为 **Codingns4DSH**（npm 包 `@jingyi0605/codingns4dsh`，设置页入口显示为 Codingns4DSH）；文中单独出现的 **Codingns4DSH** 指提供 Control API、账号与中继隧道的平台服务。

| 模块 | 作用 | 默认 |
| --- | --- | :---: |
| **外部Agent集成** | 把已安装的 Agent CLI 变成 DSH 原生会话：流式输出、工具调用、权限确认、提问、用量、思考强度 | 开 |
| **工作区会话增强** | 会话行显示 Agent Logo、归档会话入口、工作区隐藏/恢复入口、订阅/用量信息 | 关 |
| **移动端访问增强** | 手机或窄屏下收起主侧栏、设置导航改为图标轨道，支持左右横滑开合侧栏、Android 振动与局域网 PWA 通知 | 开 |
| **终端强化** | 持久终端，以及 Shell、主题、字体、光标、滚动缓冲区设置 | 关 · 需重启 |
| **局域网访问DSH** | 监听端口并把局域网地址转发到本机 DSH Web；状态指示器显示启动状态，一键复制可用的访问地址 | 常驻 |
| **登录保护** | 可选：用统一的本地账号保护局域网**和**中继访问，回环地址始终放行 | 常驻（卡片） |
| **中转访问服务** | **在互联网任何位置访问自己的 DSH Web**，端到端加密 | 关 |
| **工作区调试** | 按工作区保存启动配置、检查端口、HTTP 服务代理 | 开 |
| **Git 仓库管理** | 在右侧 Sidebar 标签页查看改动、暂存文件、提交和 Git 版本历史 | 开 |
| **文件管理增强** | 在文件侧栏创建、重命名、移动、复制、删除文件和目录，并支持代码与脚本识别 | 关 |
| **PeerHost 聚合工作台** | 当前 Host 代理已握手的其他 DSH Host，按 HostScope 聚合工作区、会话和受控工具 | 关 |

DSH 原生部分不会被替换：对话、会话列表、侧栏、设置、权限确认仍然是 DSH 自己的组件。

一切都跑在 **Host（你的电脑）** 上：Agent 进程、终端、文件、局域网/中继监听；浏览器只是视图。Agent CLI 作为 DSH 子进程使用自己的凭据与上游，模型流量不经过插件。远程访问全部可用。

补充说明：Codingns4DSH 装好后侧栏终端就已存在，**终端强化** 只是把它从基础本地 PTY 切换为持久后端（macOS/Linux 用 tmux，Windows 用 ConPTY），重启后生效；**工作区调试** 目前界面文案只有中文。

---

## 支持的外部 Agent

在 Host 上按命令名检测，版本与模型列表优先从 CLI 自身读取；没有安全只读目录接口的 Agent 只提供 Provider 默认模型，避免刷新模型时创建会话。检测到的 Agent 默认启用，可单独启停。内置的 **DeepSeek Harness** Agent 始终可用。

| Agent | id | 命令 | 协议 | 能力 | 备注 |
| --- | --- | --- | --- | --- | --- |
| Command Code | `command-code` | `command-code`、`commandcode`、`cmdc` | 单轮 CLI | 模型、流式、恢复、打断、工具、思考、用量 | 权限按 DSH 状态映射为 CLI 安全模式；没有可回传的交互式权限/提问协议 |
| Claude Code | `claude-code` | `claude` | stream-json | 模型、流式、恢复、打断、工具、思考、用量、权限确认、提问 | `can_use_tool` 权限确认与 `AskUserQuestion` 提问 |
| Kimi CLI | `kimi` | `kimi`、`kimi-cli` | stream-json | 上述全部 + 权限确认、提问、插话 | — |
| Gemini CLI | `gemini` | `gemini` | ACP | 模型、流式、恢复、打断、工具、思考、用量、权限确认、提问 | ACP 权限与 form elicitation（表单式询问） |
| Pi Agent | `pi` | `pi`、`pi-agent` | JSON-RPC | 模型、流式、恢复、打断、工具、思考、用量、插话 | 当前协议没有可验证的 DSH 权限/提问回传 |
| Codex | `codex` | `codex` | JSON-RPC（app-server） | 全部 + 权限确认、提问、插话 | — |
| OpenCode | `opencode` | `opencode`，或 `OPENCODE_SERVER_URL`（默认 `http://127.0.0.1:4096`） | HTTP + SSE | 全部 + 权限确认、提问 | — |
| Grok Build | `grok` | `grok`、`grok-build` | ACP | 模型、流式、工具、思考、用量、权限确认、提问 | ACP 权限与 form elicitation（表单式询问） |
| MiniMax Code | `mcode` | `mcode` | ACP / stream-json | 模型、流式、恢复、打断、工具、思考、用量、权限确认、提问 | 默认 ACP 路径支持交互；显式思考档位的 `exec` 路径没有交互式回传；上游贡献者：[chenjunyi000](https://github.com/chenjunyi000)；提交 PR [#6](https://github.com/jingyi0605/Codingns4DSH/pull/6)、[#7](https://github.com/jingyi0605/Codingns4DSH/pull/7) |
| ZCode | `zcode` | `zcode`、桌面端内置运行时 | JSON-RPC 裸信封 | 模型、流式、恢复、打断、用量 | 上游贡献者：[chenjunyi000](https://github.com/chenjunyi000)；提交 PR [#6](https://github.com/jingyi0605/Codingns4DSH/pull/6)、[#7](https://github.com/jingyi0605/Codingns4DSH/pull/7) |
| CodeBuddy（自动识别 CN/国际版） | `codebuddy` | `codebuddy`、`codebuddy-code`、`cbc` 及 Windows `.cmd` 入口；按环境变量与认证域名自动选择区域 | ACP（`--acp`） | 模型、流式、恢复、打断、工具、思考、用量、权限确认、提问 | 支持 stdio ACP 与 HTTP sidecar（旁路服务） ACP；CodexHost 上游贡献者：[mouzhi](https://github.com/mouzhi)；首次适配 [f30b000](https://github.com/BytePioneer-AI/codex-host/commit/f30b000f88950c40844b071eec2f6f385c6bcb49) |
| WorkBuddy | `workbuddy` | WorkBuddy 桌面应用内置 `codebuddy` | ACP（`--acp`） | 模型、流式、恢复、打断、工具、思考、权限确认、提问 | 通过 HTTP ACP sidecar（旁路服务）接入权限与 form elicitation（表单式询问）；CodexHost 上游贡献者：[BytePioneer-AI（ChongWen）](https://github.com/BytePioneer-AI)；首次适配 [6e9f365](https://github.com/BytePioneer-AI/codex-host/commit/6e9f365e2bf8ac61716f8250475530ae790f2d2f) |
| Cursor CLI | `cursor-cli` | `cursor-agent`、`agent` | ACP（`acp`） | 模型、流式、恢复、打断、工具、思考、权限确认、提问 | ACP 标准权限与 form elicitation（表单式询问）；CodexHost 上游贡献者：[mouzhi](https://github.com/mouzhi)；首次适配 [ad6ba8e](https://github.com/BytePioneer-AI/codex-host/commit/ad6ba8e04d294c473d2dcad99880496ff39c1f7e) |
| Kiro CLI | `kiro-cli` | `kiro-cli` | ACP（`acp --agent-engine v3 --auth-method cli`） | 模型、流式、恢复、打断、工具、思考、权限确认、提问 | ACP 标准权限与 form elicitation（表单式询问）；CodexHost 上游贡献者：[gy212](https://github.com/gy212)；首次适配 [79675cd](https://github.com/BytePioneer-AI/codex-host/commit/79675cdbfdc042eb37a849c3eb1539e9efc40a0d) |
| Qoder | `qoder` | `qoder`、`qodercli` | ACP（`--acp`） | 模型、流式、恢复、打断、工具、思考、权限确认、提问 | ACP 标准权限与 form elicitation（表单式询问）；CodexHost 上游贡献者：[gy212](https://github.com/gy212)、[BytePioneer-AI（ChongWen）](https://github.com/BytePioneer-AI)；PR #289 合并 [8926130](https://github.com/BytePioneer-AI/codex-host/commit/8926130af1426a467747b66d8d2dbf68f7764a7b) |
| Qoder CN | `qoder-cn` | `qodercn`、`qoderclicn` | ACP（`--acp`） | 模型、流式、恢复、打断、工具、思考、权限确认、提问 | ACP 标准权限与 form elicitation（表单式询问）；CodexHost 上游贡献者：[gy212](https://github.com/gy212)、[BytePioneer-AI（ChongWen）](https://github.com/BytePioneer-AI)；PR #289 合并 [8926130](https://github.com/BytePioneer-AI/codex-host/commit/8926130af1426a467747b66d8d2dbf68f7764a7b) |
| Antigravity | `antigravity` | `agy` | stream-json（stdin NDJSON） | 模型、流式、恢复、打断、工具、思考 | CodexHost 上游贡献者：[gy212](https://github.com/gy212)；首次适配 [ed4e785](https://github.com/BytePioneer-AI/codex-host/commit/ed4e785116642eafc08e4186e92e83f3816c7765) |

**模型** 模型列表 · **流式** 实时输出 · **恢复** 重启后继续 · **打断** 取消当前回合 · **工具** 对话中渲染工具调用 · **思考** 推理/思考强度 · **用量** token 或订阅额度 · **权限确认 / 提问** 变成 DSH 原生交互 · **插话** 回合中追加消息。

未列出的能力表示该 CLI 或其版本不支持；Agent 的安装与登录都在 DSH 之外完成，Codingns4DSH 不保存 Agent 凭据。

权限确认和提问都由 DSH 原生组件承载。支持交互式回传的适配器会把 Provider 请求转换为公共的 `permission-request` 或 `question-request` 事件，交给 DSH 原生审批/问题组件，再按 Provider 协议和原始请求 ID 回传。ACP 适配器接入标准 `session/request_permission` 与 `elicitation/create` form（表单式询问）；URL elicitation（URL 询问）需要浏览器安全确认流程，当前不宣告该能力。没有可验证回传协议的 Agent 保持能力未声明；Command Code 和 Antigravity 只根据 DSH 权限状态下发 CLI 安全模式。

---

## 功能详解

### 外部 Agent 集成

在选择器里挑选 Agent 与模型后，Codingns4DSH 以 DSH 子进程方式启动（或恢复）该 CLI，并把事件流投影成原生会话；模型与思考强度按 Agent 记忆。

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/agent-picker.jpg" alt="工作区会话增强：Agent Logo、归档会话与工作区列表"></td>
      <td><img width="100%" src="assets/screenshots/model-picker.jpg" alt="Codex 的模型列表"></td>
    </tr>
  </table>
</div>

模型列表直接读取自各 CLI，可随时切换；按钮上还会显示当前模型与思考强度。

外部 Agent 自己组装请求，上下文面板的启发式构成与真实用量不同源；这些会话的面板只保留占用百分比与总量，不显示「系统 / 工具 / 消息」明细。

### 会话增强与订阅用量

会话行显示 Agent Logo 与归档入口，输入框下方显示可读取额度的 Agent 的订阅或上游用量（含缓存命中率、按模型统计与费用）。「显示订阅/用量检测」右侧的“设置”按钮可调整查询超时（默认 10 秒，作用于所有 Agent）与自动查询间隔（默认 5 分钟，0 表示不自动查询）；同一 Agent 在间隔内切回时复用上次结果，不重复请求上游。

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/subscription-usage.jpg" alt="Codex 上游用量与费用统计"></td>
      <td><img width="100%" src="assets/screenshots/subscription-plan.jpg" alt="Codex 订阅额度与重置时间"></td>
    </tr>
  </table>
</div>

用量来自 Agent 自身的额度接口或已配置的上游用量来源；数据只在 Host 上读取，不写入浏览器存储。Codex 官方订阅的弹层还会显示「剩余点数」（credits 余额，保留两位小数）与「重置次数」（与重置图标按钮同行展示，含每张到期时间）；点击后经确认模态框消耗 1 次重置次数立即恢复当前用量窗口，整条链路走 codex app-server 官方协议，Host 不接触订阅凭据。

CodeBuddy 与 WorkBuddy 的 ACP `usage_update` 和本地会话用量已经接入；官方套餐 billing 仍由 Host 侧按认证域名读取，认证或接口不可用时安全返回空值。CodeBuddy CN 与国际版共用一个适配器，当前区域自动决定认证、模型目录和套餐来源，不会把另一地区账号的数据串过来。

### 工作区调试

每个工作区一份启动配置（`<工作区>/.codingns/debug.json`）：命令、工作目录、环境变量、Shell 与可选端口，可一键启动、检查端口、结束进程或停止。可选反向代理会把端口通过 DSH 暴露出来，目前仅支持 HTTP。

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/workspace-debug.jpg" alt="工作区调试面板：启动配置、端口状态与代理"></td>
      <td><img width="100%" src="assets/screenshots/workspace-debug-edit.jpg" alt="工作区调试面板：编辑启动配置"></td>
    </tr>
  </table>
</div>

面板实时显示端口监听状态与 PID，并按实例生成不可猜测的代理地址。

### Git 仓库管理

Git 面板通过 DSH 原生右侧 Sidebar 的标签页入口打开，按 Workspace 保存状态并跨会话复用。未初始化的目录可直接初始化仓库；已初始化的仓库支持查看暂存文件和未提交文件、暂存/取消暂存、丢弃更改、填写提交说明、切换分支和浏览提交历史。模块关闭后会移除右侧标签及对应 Host Git RPC，不影响其他模块。

### 文件管理增强

文件管理增强把常用文件操作接入 DSH 原生文件侧栏：可以创建文件和目录、重命名、移动、复制、删除，并按代码与脚本类型选择编辑入口。操作会经过 Workspace 路径校验，拒绝越出当前工作区；模块关闭后清理对应的侧栏入口和 Host RPC。

### PeerHost 多 Host 工作区

PeerHost 是当前 Host 的代理能力，不会切换当前登录 Host。启用后可在管理面板添加局域网 PeerHost，Host 侧保存目标配置和登录态，Client 只提交 `targetHostId` 与完整 `HostScope`（`hostId`、`targetHostId`、`workspaceId`、`sessionId`、`scopeGeneration`）。工作区、会话、聊天输入、实时事件、文件、Git、终端和右侧工具都按作用域路由，单个 PeerHost 故障不会阻塞当前 Host 或其他 PeerHost。

当前已验证的路径包括固定握手、HTTP/WS 正向白名单、Host-to-Host 局域网 `/ws` connector、实时事件过滤、有限指数退避、generation 重建和脱敏诊断。DSH 原生导航或 conversation 容器未提供稳定扩展点时，界面会显示明确的 `degraded`/`unsupported` 状态，不创建 iframe，也不会把远端 Web Context 冒充成原生三栏聚合。

中转 PeerHost 仍保持 `relay_unavailable/degraded`：现有浏览器中转 ticket 和任意公网 URL 不能替代经过验证的 Host-to-Host JSON/WS Transport。当前 Host 的既有局域网访问、中转访问、登录和单 Host 会话语义不受 PeerHost 影响。

### 模块与设置

设置页按模块渲染卡片，开关、说明和「是否需要重启」都来自模块自身的描述；终端外观、局域网映射、登录保护、中转账号等都在对应卡片内配置。

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/settings-overview.jpg" alt="设置 → Codingns4DSH 模块卡片"></td>
      <td><img width="100%" src="assets/screenshots/settings-modules.jpg" alt="全部模块开关"></td>
    </tr>
  </table>
</div>

### 登录保护

默认关闭，在卡片中开启后用统一的本地账号保护局域网**和**中继访问（默认会话超时 30 分钟）。认证发生在 Host 的转发边界，未登录请求不会到达 DSH Web；`127.0.0.1` 与 `::1` 永远放行，避免把自己锁在外面。

<div align="center">
  <img width="70%" src="assets/screenshots/login-protection.jpg" alt="本地账号登录页">
</div>

密码以 `scrypt` 哈希保存在 `0600` 文件中，浏览器只持有 `HttpOnly`、`SameSite=Strict` 会话 Cookie。

### 远程访问

| | 局域网访问 | 中转访问服务 |
| --- | --- | --- |
| 从哪里连接 | 同一局域网 | **任何设备、互联网上的任何位置** |
| 前提 | 同一网络 + 放行监听端口 | Host 能通过 HTTPS 访问 Control API；设备能连上 Codingns4DSH 入口 |
| 是否暴露本地端口 | 是——所选网卡/端口（默认 `13080`） | 否——独立设备隧道 |
| 账号 | 可选登录保护 | 需要 Codingns4DSH 账号并绑定 Host |

**局域网**：选择监听网卡与端口，自动探测（或手动填写）本机 DSH Web 端口，启动后在另一台设备打开 `http://<局域网 IP>:<端口>`；开启自动启动可恢复映射，模块还会补齐明文 HTTP 来源所需的 `crypto.randomUUID`。

**中转**：配置 Control API（默认 `https://channel.codingns.com:1443`，可在此注册账号），登录、刷新设备、绑定当前 Host（显示标签、公钥、指纹），之后在任意设备通过 **`https://dsh.codingns.com`** 打开已绑定的 Host——不需要公网 IP、端口映射或 VPN。

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/relay-service.jpg" alt="中转访问服务卡片"></td>
      <td><img width="100%" src="assets/screenshots/relay-h5-login.jpg" alt="H5 登录页选择 DSH Host"></td>
    </tr>
  </table>
</div>

DSH 设置按钮旁的账户入口会显示登录状态、访问路径与延迟、Host CPU/内存，并可一键注销登录。

<div align="center">
  <img width="70%" src="assets/screenshots/relay-status.jpg" alt="账户状态弹层：访问路径、延迟、CPU 与内存">
</div>

其中「访问」会标明当前是通过本机、局域网还是中转进入 DSH Web。

**为什么中转看不到你的 DSH 内容**——隧道端到端加密，使用它不等于把对话交给服务器：

- 载荷走在 **DSH Client 与 DSH Host 之间的 WebRTC DataChannel，由 DTLS 保护**；无论直连还是经 TURN，Relay 都只承载密文。
- Relay 与控制站只处理**控制面元数据**：账号/设备记录、Host 绑定、ticket、SDP/ICE 信令、在线状态、流量统计。
- 每个 Host 自持 DTLS 证书（`~/.config/codingns4dsh/dtls-identity.json`）并发布 SHA-256 指纹，远端在握手时核对；不一致直接中断（`Host DTLS fingerprint 校验失败`），不会接受被替换的证书；同一指纹显示在中转卡片中供人工比对。
- 密码只用于登录请求；refresh token 与设备凭据留在 Host。诊断日志只记录协议元数据（方向、类型、流 ID、状态、字节数），不记录正文、票据、Cookie 或 DSH Web 内容。

---

## 安装

**环境要求**：DSH `>=0.2.0-rc.2 <=0.2.1-alpha.1`（已验证 `0.2.1-alpha.1`）· Node.js `>= 22.19` · `PATH` 中有 `pnpm`（`dsh plugin` 转发给 pnpm）· 可选：Agent CLI，以及 macOS/Linux 上用于持久终端的 `tmux`（`brew install tmux` / `sudo apt install tmux`）。

### 最简单的安装方式：使用内置 `web` Profile

DSH 的 `web` Profile 会在首次使用时自动初始化，不需要手动创建配置文件，也不需要执行 `--dump-config`：

```bash
dsh plugin --profile web add @jingyi0605/codingns4dsh@0.2.1-beta.1
dsh web
```

### 可选：使用独立 Profile

如果不想修改内置的 `web` Profile，再创建一个独立 Profile。这里的 `--dump-config` 只用于初始化并检查 Profile，不是插件安装的必需步骤：

```bash
dsh codingns --from-default-profile web --dump-config
dsh plugin --profile codingns add @jingyi0605/codingns4dsh@0.2.1-beta.1
dsh codingns
```

- **不要**用 `dsh plugin --profile <新名字> add …` 创建需要 Web 界面的独立 Profile：该命令只会从 `@deepseek-ai/dsh-base` 初始化，之后会报 `entry "terminal-controller" not found`。需要独立 Profile 时，请使用上面的 `--from-default-profile web`。
- npm 返回 404 说明该版本还没发布，请改用下面的源码安装。

```bash
# 可选：验证安装结果
dsh plugin --profile web list --depth 0           # -> codingns4dsh <版本>

# 升级、固定版本、卸载（之后重启 DSH）
dsh plugin --profile web add @jingyi0605/codingns4dsh@<版本>
dsh plugin --profile web remove @jingyi0605/codingns4dsh
```

**从源码安装到 Stage0**（仅用于开发验证）：

```bash
git clone https://github.com/jingyi0605/Codingns4DSH.git && cd Codingns4DSH
pnpm install && pnpm build
DSH_STAGE0_HOME="$HOME/.dsh-stage0-020" pnpm dev:link stage0
pnpm dsh:stage0
```

源码链接只允许进入专用的 Stage0 Profile。不要对 Desktop Profile 执行
`dsh plugin ... add "$PWD"`，也不要把 `pnpm pack` 产生的 `.tgz` 安装到 Desktop；
这两种方式都会把开发中的代码带进桌面端。需要在临时目录回放安装包时，使用
`pnpm replay:dsh-install ./<包文件>.tgz`，脚本会创建一次性的 `DSH_HOME`，不会接触
`~/.dsh` 或 `~/.dsh-stage0-020`。

Desktop 只通过 GUI 插件页安装已发布的 registry 版本，并固定版本号；Desktop 的
`~/.dsh/profiles/desktop` 与 Stage0 的 `~/.dsh-stage0-020/profiles/stage0` 不共享
插件目录、设置目录、会话目录或开发链接。修改源码后，在 Stage0 中重新 `pnpm build`
（或保持 `pnpm dev:watch`）并重启 Stage0 DSH。

**磁盘状态**：设置保存在 `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`）的 `codingns:` 命名空间。

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/profiles/<profile>` | 已安装的插件包与 `dsh.profile.bundles` |
| `$DSH_HOME/codingns4dsh/` | 终端 `host-id` 与 `terminals.json`（恢复映射） |
| `~/.config/codingns4dsh/` | 中转凭据、DTLS 身份、登录保护哈希 |
| `<工作区>/.codingns/debug.json` | 调试启动配置（`0600`，拒绝保存密钥） |

---

## 首次使用

1. `dsh codingns` 打开 DSH Web 界面。
2. 打开 **设置 → Codingns4DSH** 查看模块卡片（需重启的模块会同时显示当前生效状态与下次启动目标）。
3. 在 DSH **之外** 安装并登录 Agent CLI，确保命令在 Host 的 `PATH` 中，然后在 **外部Agent集成** 中启用。
4. 在输入框选择 Agent、模型和思考强度并发送消息——输出流式写入原生会话，并带 Agent Logo 出现在侧栏。
5. 右侧栏：终端面板为当前工作区开终端（要持久化请启用 **终端强化** 后重启）；**调试** 面板添加启动配置并查看端口。
6. 需要远程使用时，开启 **登录保护**、配置 **局域网访问DSH**，或登录 **中转访问服务** 从任意网络访问；账户入口会显示当前访问路径与 Host 负载。

---

## 故障排查

- **版本** —— `dsh --version`、`dsh plugin --profile web list --depth 0`（独立 Profile 请替换 `web`）、`npm view @jingyi0605/codingns4dsh version`；启动时会拒绝范围外的 DSH，安装期在能识别当前运行时版本时同样拒绝。
- **安装期被 `PATH` 上的旧 `dsh` 误判** —— 安装期只把宿主注入的版本、Desktop Runtime 根和 Profile 内可解析的 `@deepseek-ai/dsh` 当作阻断依据；`PATH` 上的 `dsh --version` 仅用于提示，不会阻断安装。运行期仍以实际加载的 DSH 为准。
- **`patch: entry "terminal-controller" not found`** —— Profile 缺少 Web 应用层，按上文用 `web` 模板重建。
- **检测不到 Agent** —— 在 Host 上执行 `<cli> --version`；确认其目录在启动 DSH 的进程的 `PATH` 中（图形启动器常不同）；用各家工具登录后重启 DSH。
- **终端** —— macOS/Linux 持久模式需要 `tmux`；启停模块与修改绑定范围需重启；终端按工作区寻址。
- **局域网** —— 确认卡片启动状态与访问地址、防火墙放行、两台设备同网络；多个 DSH 实例时手动选择探测到的端口；开启登录保护后需先登录。
- **中转** —— 检查 Control API 可达性，会话过期则重新登录，刷新设备后绑定 Host。
- **日志** —— 默认不输出调试日志；需要完整排查启动或 RPC 时使用 `CODINGNS4DSH_DEBUG=1 dsh --profile stage0 --no-open`。只查看警告和错误时使用 `CODINGNS4DSH_DEBUG_LEVEL=warn dsh --profile stage0 --no-open`，也可简写为 `CODINGNS4DSH_DEBUG=warn`。旧变量 `CODINGNS4DSH_TUNNEL_DEBUG=1` 仍兼容；pnpm 安装日志在 `$DSH_HOME/profiles/<profile>/.plugin-manager/logs/`。
- **反馈** —— 附上 DSH 与 Codingns4DSH 版本、操作系统、涉及模块和完整错误：[GitHub Issues](https://github.com/jingyi0605/Codingns4DSH/issues) 或 QQ **1092985965**。

---

## 开发

需要 Node `>= 22.19` 与 pnpm：

```bash
pnpm install
pnpm build            # 版本校验 → tsc → Client + H5 Bundle
pnpm test             # 构建后运行完整测试（当前 901 个用例）
pnpm typecheck
pnpm run capability:check   # DSH 能力注册表退休检查
```

开发循环：`pnpm dev:watch` 配合
`DSH_STAGE0_HOME="$HOME/.dsh-stage0-020" pnpm dev:link stage0`，然后只重启 Stage0 DSH。
`pnpm dev:link stage0` 在未设置变量时也会默认使用专用 Stage0 HOME；若显式把
`DSH_HOME` 指向 `~/.dsh`，脚本会拒绝执行。版本源是 `version.json`
（`version:set-plugin` / `version:set-dsh`，由 `version:check` 守卫）。

目录：`src/host`（Host 层）、`src/client`（浏览器层）、`src/dsh-capabilities`（DSH 能力注册与版本路由）、`src/shared/contracts`、`src/transport`（隧道与 WebRTC）、`src/features`（模块注册表）、`tests/`、`specs/`、`docs/`、`data/build`（已忽略）。

推送 `v*` tag 触发 GitHub Actions（tag/版本校验、冻结安装、类型检查、测试、`npm pack`）并以 provenance 发布，预发布版本用 `next` dist-tag。当前发布还会执行 DSH 安装回放、运行时模块解析和 npm 产物逐文件校验。

截图素材与清单见 [assets/screenshots](assets/screenshots/README.md)。

**英文版：[README.en.md](README.en.md)**

---

## 鸣谢

Codingns4DSH 的项目灵感与部分实现思路来自 **[CodexHost](https://github.com/BytePioneer-AI/codex-host)**——它把 Pi、Claude Code、Grok Build 等 Harness 原生跑在 Codex Desktop 里，展示了 Codingns4DSH 从另一侧沿用的方向：**把其他 Harness 作为一等 Agent 接入**，而不是替换它们。多 Harness 适配器模型、把 CLI 事件流投影为宿主原生会话、让每个 Agent 的会话留在宿主侧栏与输入框，都源自该项目的设计。感谢其作者与社区。

Codingns4DSH 是独立项目，与 CodexHost 无隶属关系。

---

## 许可证

本项目以 **GNU 通用公共许可证第 3 版或更高版本**发布（SPDX：`GPL-3.0-or-later`），完整条款见 [LICENSE](LICENSE)，`package.json` 中的 `license` 字段与之保持一致。

Copyright (C) 2026 jingyi0605

你可以在许可证允许的范围内自由使用、修改和分发本项目；分发衍生作品时须同样以 GPL 授权、附上完整源码并保留版权声明，且本项目不提供任何担保。
