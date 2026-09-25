<div align="center">

# DSH-CodingNS for DeepSeek Harness

**把外部 Agent CLI、持久终端、工作区调试和远程访问，装进 DSH 原生界面。**

[![npm version](https://img.shields.io/npm/v/dsh-codingns?logo=npm)](https://www.npmjs.com/package/dsh-codingns)
[![DSH compatibility](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.3%20%3C0.1.8--0-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-3C873A?logo=node.js&logoColor=white)](https://nodejs.org)

**简体中文** · [English](README.en.md)

**当前版本 `dsh-codingns@0.1.1`** · DSH **`>=0.1.5-rc.3 <0.1.8-0`**（已验证 `0.1.6-alpha.2`）· Node **`>= 22.19`** · macOS / Linux / Windows

**[GitHub](https://github.com/jingyi0605/DSH-CodingNS)** · **[npm](https://www.npmjs.com/package/dsh-codingns)** · **QQ 群 1092985965**

<p>
  <a href="#界面预览">界面预览</a> ·
  <a href="#这是什么">这是什么</a> ·
  <a href="#支持的外部-agent">外部 Agent</a> ·
  <a href="#功能详解">功能详解</a> ·
  <a href="#安装">安装</a> ·
  <a href="#首次使用">首次使用</a> ·
  <a href="#故障排查">故障排查</a> ·
  <a href="#开发">开发</a> ·
  <a href="#鸣谢">鸣谢</a>
</p>

</div>

## 界面预览

<div align="center">
  <img width="90%" src="assets/screenshots/agent-picker.jpg" alt="输入框中的 Agent 选择器与带 Logo 的会话列表">
</div>

输入框的 Agent 选择器：内置 DeepSeek Harness 与全部已安装的外部 Agent；左侧会话列表带 Agent Logo，并提供归档会话入口。

---

## 这是什么

**DSH（DeepSeek Harness）** 是 DeepSeek 的编码 Agent 运行框架，由 CLI 和 Web 界面组成，在你的 Workspace 中运行 Agent 循环。

**DSH-CodingNS 是一个 DSH 插件 Bundle**（Host 层 + 浏览器层），提供七个模块，全部在 **设置 → CodingNS** 中配置。

> 名称说明：本插件名为 **DSH-CodingNS**（npm 包 `dsh-codingns`，设置页入口显示为 CodingNS）；文中单独出现的 **CodingNS** 指提供 Control API、账号与中继隧道的平台服务。

| 模块 | 作用 | 默认 |
| --- | --- | :---: |
| **外部Agent集成** | 把已安装的 Agent CLI 变成 DSH 原生会话：流式输出、工具调用、权限确认、提问、用量、思考强度 | 开 |
| **工作区会话增强** | 会话行显示 Agent Logo、归档会话入口、订阅/用量信息 | 关 |
| **终端强化** | 持久终端，以及 Shell、主题、字体、光标、滚动缓冲区设置 | 关 · 需重启 |
| **局域网访问DSH** | 监听端口并把局域网地址转发到本机 DSH Web | 常驻 |
| **登录保护** | 可选：用统一的本地账号保护局域网**和**中继访问，回环地址始终放行 | 常驻（卡片） |
| **中转访问服务** | **在互联网任何位置访问自己的 DSH Web**，端到端加密 | 关 |
| **工作区调试** | 按工作区保存启动配置、检查端口、HTTP 服务代理 | 开 |

DSH 原生部分不会被替换：对话、会话列表、侧栏、设置、权限确认仍然是 DSH 自己的组件。

一切都跑在 **Host（你的电脑）** 上：Agent 进程、终端、文件、局域网/中继监听；浏览器只是视图。Agent CLI 作为 DSH 子进程使用自己的凭据与上游，模型流量不经过插件。远程访问全部可用。

补充说明：DSH-CodingNS 装好后侧栏终端就已存在，**终端强化** 只是把它从基础本地 PTY 切换为持久后端（macOS/Linux 用 tmux，Windows 用 ConPTY），重启后生效；在 DSH `0.1.5.x` 上 DSH-CodingNS 运行于兼容模式（无多 Tab 与 Shell 选择），卡片会给出提示；**工作区调试** 目前界面文案只有中文。

---

## 支持的外部 Agent

在 Host 上按命令名检测，版本与模型列表从 CLI 自身读取；检测到的 Agent 默认启用，可单独启停。内置的 **DeepSeek Harness** Agent 始终可用。

| Agent | id | 命令 | 协议 | 能力 |
| --- | --- | --- | --- | --- |
| Command Code | `command-code` | `command-code`、`commandcode`、`cmdc` | 单轮 CLI | 模型、流式、恢复、打断、工具、思考、用量 |
| Claude Code | `claude-code` | `claude` | stream-json | 模型、流式、恢复、打断、工具、思考、用量 |
| Kimi CLI | `kimi` | `kimi`、`kimi-cli` | stream-json | 上述全部 + 权限确认、提问、插话 |
| Gemini CLI | `gemini` | `gemini` | ACP | 模型、流式、恢复、打断、工具、思考、用量、权限确认 |
| Pi Agent | `pi` | `pi`、`pi-agent` | JSON-RPC | 模型、流式、恢复、打断、工具、思考、用量、插话 |
| Codex | `codex` | `codex` | JSON-RPC（app-server） | 全部 + 权限确认、提问、插话 |
| OpenCode | `opencode` | `opencode`，或 `OPENCODE_SERVER_URL`（默认 `http://127.0.0.1:4096`） | HTTP + SSE | 全部 + 权限确认、提问 |
| Grok Build | `grok` | `grok`、`grok-build` | ACP | 模型、流式、工具、思考、用量、权限确认 |

**模型** 模型列表 · **流式** 实时输出 · **恢复** 重启后继续 · **打断** 取消当前回合 · **工具** 对话中渲染工具调用 · **思考** 推理/思考强度 · **用量** token 或订阅额度 · **权限确认 / 提问** 变成 DSH 原生交互 · **插话** 回合中追加消息。

未列出的能力表示该 CLI 或其版本不支持；Agent 的安装与登录都在 DSH 之外完成，DSH-CodingNS 不保存 Agent 凭据。

---

## 功能详解

### 外部 Agent 集成

在选择器里挑选 Agent 与模型后，DSH-CodingNS 以 DSH 子进程方式启动（或恢复）该 CLI，并把事件流投影成原生会话；模型与思考强度按 Agent 记忆。

<div align="center">
  <img width="70%" src="assets/screenshots/model-picker.jpg" alt="Codex 的模型列表">
</div>

模型列表直接读取自各 CLI，可随时切换；按钮上还会显示当前模型与思考强度。

### 会话增强与订阅用量

会话行显示 Agent Logo 与归档入口，输入框下方显示可读取额度的 Agent 的订阅或上游用量（含缓存命中率、按模型统计与费用）。

<div align="center">
  <img width="70%" src="assets/screenshots/subscription-usage.jpg" alt="Codex 上游用量与费用统计">
</div>

用量来自 Agent 自身的额度接口或已配置的上游用量来源；数据只在 Host 上读取，不写入浏览器存储。

### 工作区调试

每个工作区一份启动配置（`<工作区>/.codingns/debug.json`）：命令、工作目录、环境变量、Shell 与可选端口，可一键启动、检查端口、结束进程或停止。可选反向代理会把端口通过 DSH 暴露出来，目前仅支持 HTTP。

<div align="center">
  <img width="70%" src="assets/screenshots/workspace-debug.jpg" alt="工作区调试面板：启动配置、端口状态与代理">
</div>

面板实时显示端口监听状态与 PID，并按实例生成不可猜测的代理地址。

### 模块与设置

设置页按模块渲染卡片，开关、说明和「是否需要重启」都来自模块自身的描述；终端外观、局域网映射、登录保护、中转账号等都在对应卡片内配置。

| <img src="assets/screenshots/settings-overview.jpg" alt="设置 → CodingNS 模块卡片"> | <img src="assets/screenshots/settings-modules.jpg" alt="全部模块开关"> |
| --- | --- |
| 每个模块一张卡片，右侧是启停开关 | 七个模块与底部版本信息 |

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
| 前提 | 同一网络 + 放行监听端口 | Host 能通过 HTTPS 访问 Control API；设备能连上 CodingNS 入口 |
| 是否暴露本地端口 | 是——所选网卡/端口（默认 `13080`） | 否——独立设备隧道 |
| 账号 | 可选登录保护 | 需要 CodingNS 账号并绑定 Host |

**局域网**：选择监听网卡与端口，自动探测（或手动填写）本机 DSH Web 端口，启动后在另一台设备打开 `http://<局域网 IP>:<端口>`；开启自动启动可恢复映射，模块还会补齐明文 HTTP 来源所需的 `crypto.randomUUID`。

**中转**：配置 Control API（默认 `https://channel.codingns.com:1443`，可在此注册账号），登录、刷新设备、绑定当前 Host（显示标签、公钥、指纹），之后在任意设备通过 **`https://dsh.codingns.com`** 打开已绑定的 Host——不需要公网 IP、端口映射或 VPN。

| <img src="assets/screenshots/relay-service.jpg" alt="中转访问服务卡片"> | <img src="assets/screenshots/relay-h5-login.jpg" alt="H5 登录页选择 DSH Host"> |
| --- | --- |
| 中转卡片：服务地址、账号、设备列表与 H5 登录地址 | 在任意设备的 H5 页面选择已绑定的 Host 并连接 |

DSH 设置按钮旁的账户入口会显示登录状态、访问路径与延迟、Host CPU/内存，并可一键注销登录。

<div align="center">
  <img width="45%" src="assets/screenshots/relay-status.jpg" alt="账户状态弹层：访问路径、延迟、CPU 与内存">
</div>

其中「访问」会标明当前是通过本机、局域网还是中转进入 DSH Web。

**为什么中转看不到你的 DSH 内容**——隧道端到端加密，使用它不等于把对话交给服务器：

- 载荷走在 **DSH Client 与 DSH Host 之间的 WebRTC DataChannel，由 DTLS 保护**；无论直连还是经 TURN，Relay 都只承载密文。
- Relay 与控制站只处理**控制面元数据**：账号/设备记录、Host 绑定、ticket、SDP/ICE 信令、在线状态、流量统计。
- 每个 Host 自持 DTLS 证书（`~/.config/dsh-codingns/dtls-identity.json`）并发布 SHA-256 指纹，远端在握手时核对；不一致直接中断（`Host DTLS fingerprint 校验失败`），不会接受被替换的证书；同一指纹显示在中转卡片中供人工比对。
- 密码只用于登录请求；refresh token 与设备凭据留在 Host。诊断日志只记录协议元数据（方向、类型、流 ID、状态、字节数），不记录正文、票据、Cookie 或 DSH Web 内容。

---

## 安装

**环境要求**：DSH 在 `>=0.1.5-rc.3 <0.1.8-0` 范围内（插件与 DSH 版本独立发布，安装期与运行期都会拒绝不兼容版本）· Node.js `>= 22.19` · `PATH` 中有 `pnpm`（`dsh plugin` 转发给 pnpm）· 可选：Agent CLI，以及 macOS/Linux 上用于持久终端的 `tmux`（`brew install tmux` / `sudo apt install tmux`）。

DSH-CodingNS 需要 Profile 同时包含 DSH Web 应用层，因此先用官方 `web` 模板创建 Profile：

```bash
dsh codingns --from-default-profile web --dump-config   # 创建 Profile（只打印层结构，不启动）
dsh plugin --profile codingns add dsh-codingns@0.1.1    # 安装 Bundle
dsh codingns                                            # 启动 DSH
```

也可直接装进标准 `web` Profile：`dsh plugin --profile web add dsh-codingns@0.1.1`，然后 `dsh web`。

- **不要**把 `dsh plugin --profile <新名字> add …` 当作新 Profile 的第一条命令：全新自定义 Profile 只含 `@deepseek-ai/dsh-base`，会报 `entry "terminal-controller" not found` 且没有浏览器界面。
- npm 返回 404 说明该版本还没发布，请改用下面的源码安装。

```bash
# 验证
dsh plugin --profile codingns list --depth 0     # -> dsh-codingns <版本>
dsh --profile codingns --dump-config             # 应看到 id: dsh-codingns，terminal-controller 为 disabled

# 升级、固定版本、卸载（之后重启 DSH）
dsh plugin --profile codingns add dsh-codingns@<版本>
dsh plugin --profile codingns remove dsh-codingns
```

**从源码安装**（npm 不可用，或直接运行本地检出）：

```bash
git clone https://github.com/jingyi0605/DSH-CodingNS.git && cd DSH-CodingNS
pnpm install && pnpm build
dsh codingns --from-default-profile web --dump-config
dsh plugin --profile codingns add "$PWD"            # 或 npm pack 后 add ./dsh-codingns-0.1.1.tgz
```

安装目录是链接依赖，改完源码后重新 `pnpm build`（或保持 `pnpm dev:watch`）并重启 DSH。

**磁盘状态**：设置保存在 `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`）的 `codingns:` 命名空间。

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/profiles/<profile>` | 已安装的插件包与 `dsh.profile.bundles` |
| `$DSH_HOME/dsh-codingns/` | 终端 `host-id` 与 `terminals.json`（恢复映射） |
| `~/.config/dsh-codingns/` | 中转凭据、DTLS 身份、登录保护哈希 |
| `<工作区>/.codingns/debug.json` | 调试启动配置（`0600`，拒绝保存密钥） |

---

## 首次使用

1. `dsh codingns` 打开 DSH Web 界面。
2. 打开 **设置 → CodingNS** 查看模块卡片（需重启的模块会同时显示当前生效状态与下次启动目标）。
3. 在 DSH **之外** 安装并登录 Agent CLI，确保命令在 Host 的 `PATH` 中，然后在 **外部Agent集成** 中启用。
4. 在输入框选择 Agent、模型和思考强度并发送消息——输出流式写入原生会话，并带 Agent Logo 出现在侧栏。
5. 右侧栏：终端面板为当前工作区开终端（要持久化请启用 **终端强化** 后重启）；**调试** 面板添加启动配置并查看端口。
6. 需要远程使用时，开启 **登录保护**、配置 **局域网访问DSH**，或登录 **中转访问服务** 从任意网络访问；账户入口会显示当前访问路径与 Host 负载。

---

## 故障排查

- **版本** —— `dsh --version`、`dsh plugin --profile codingns list --depth 0`、`npm view dsh-codingns version`；安装与启动都会拒绝范围外的 DSH。
- **`patch: entry "terminal-controller" not found`** —— Profile 缺少 Web 应用层，按上文用 `web` 模板重建。
- **检测不到 Agent** —— 在 Host 上执行 `<cli> --version`；确认其目录在启动 DSH 的进程的 `PATH` 中（图形启动器常不同）；用各家工具登录后重启 DSH。
- **终端** —— macOS/Linux 持久模式需要 `tmux`；启停模块与修改绑定范围需重启；终端按工作区寻址。
- **局域网** —— 确认卡片转发信息、防火墙放行、两台设备同网络；多个 DSH 实例时手动选择探测到的端口；开启登录保护后需先登录。
- **中转** —— 检查 Control API 可达性，会话过期则重新登录，刷新设备后绑定 Host。
- **日志** —— `DSH_CODINGNS_TUNNEL_DEBUG=1 dsh codingns --no-open`（仅元数据）；pnpm 安装日志在 `$DSH_HOME/profiles/<profile>/.plugin-manager/logs/`。
- **反馈** —— 附上 DSH 与 DSH-CodingNS 版本、操作系统、涉及模块和完整错误：[GitHub Issues](https://github.com/jingyi0605/DSH-CodingNS/issues) 或 QQ **1092985965**。

---

## 开发

需要 Node `>= 22.19` 与 pnpm：

```bash
pnpm install
pnpm build            # 版本校验 → tsc → Client + H5 Bundle
pnpm test             # 构建后运行 61 个测试套件
pnpm typecheck
pnpm run capability:check   # DSH 能力注册表退休检查
```

开发循环：`pnpm dev:watch` 配合 `pnpm dev:link <profile>`，然后重启 DSH。版本源是 `version.json`（`version:set-plugin` / `version:set-dsh`，由 `version:check` 守卫）。

目录：`src/host`（Host 层）、`src/client`（浏览器层）、`src/dsh-capabilities`（DSH 能力注册与版本路由）、`src/shared/contracts`、`src/transport`（隧道与 WebRTC）、`src/features`（模块注册表）、`tests/`、`specs/`、`docs/`、`data/build`（已忽略）。

推送 `v*` tag 触发 GitHub Actions（tag/版本校验、冻结安装、类型检查、测试、`npm pack`）并以 provenance 发布，预发布版本用 `next` dist-tag。路线图：PeerHost、文件管理、工作区会话、调试代理完善（鉴权 + WebSocket）、Git、SKILL、更多。

截图素材与清单见 [assets/screenshots](assets/screenshots/README.md)。

**英文版：[README.en.md](README.en.md)**

---

## 鸣谢

DSH-CodingNS 的项目灵感与部分实现思路来自 **[CodexHost](https://github.com/BytePioneer-AI/codex-host)**——它把 Pi、Claude Code、Grok Build 等 Harness 原生跑在 Codex Desktop 里，展示了 DSH-CodingNS 从另一侧沿用的方向：**把其他 Harness 作为一等 Agent 接入**，而不是替换它们。多 Harness 适配器模型、把 CLI 事件流投影为宿主原生会话、让每个 Agent 的会话留在宿主侧栏与输入框，都源自该项目的设计。感谢其作者与社区。

DSH-CodingNS 是独立项目，与 CodexHost 无隶属关系。
