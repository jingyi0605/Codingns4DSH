<div align="center">

# CodingNS for DeepSeek Harness

**Your existing Agent CLIs, persistent terminals, workspace debug and remote access — inside DSH's own UI.**

[![npm version](https://img.shields.io/npm/v/dsh-codingns?logo=npm)](https://www.npmjs.com/package/dsh-codingns)
[![DSH compatibility](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.3%20%3C0.1.8--0-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-3C873A?logo=node.js&logoColor=white)](https://nodejs.org)

**`0.1.1`** · DSH **`>=0.1.5-rc.3 <0.1.8-0`** (validated `0.1.6-alpha.2`) · Node **`>= 22.19`** · macOS / Linux / Windows

**[GitHub](https://github.com/jingyi0605/DSH-CodingNS)** · **[npm](https://www.npmjs.com/package/dsh-codingns)** · **QQ group 1092985965**

<p>
  <a href="#interface-preview">Preview</a> ·
  <a href="#what-is-codingns">What it is</a> ·
  <a href="#supported-external-agents">Agents</a> ·
  <a href="#installation">Install</a> ·
  <a href="#first-run">First run</a> ·
  <a href="#remote-access">Remote access</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#development">Development</a> ·
  <a href="#中文说明">简体中文</a>
</p>

</div>

## Interface Preview

> 🖼️ **Placeholder** `docs/配图/imgs/overview.png` — one window: composer Agent picker, session sidebar with Agent logos, persistent terminal, 调试 panel. *1600×900; shot list in [README 配图清单](docs/配图/20260925-README配图清单.md)*

| | |
| --- | --- |
| 🖼️ `docs/配图/imgs/agent-picker.png`<br><sub>Composer: Agent, model, thinking effort</sub> | 🖼️ `docs/配图/imgs/sessions.png`<br><sub>Session rows: Agent logo, archive entry, usage</sub> |
| 🖼️ `docs/配图/imgs/terminal.png`<br><sub>Sidebar terminal restored after restart</sub> | 🖼️ `docs/配图/imgs/debug.png`<br><sub>调试 panel: launch profile, port, proxy</sub> |
| 🖼️ `docs/配图/imgs/settings.png`<br><sub>Settings → CodingNS module cards</sub> | 🖼️ `docs/配图/imgs/relay.png`<br><sub>Relay card + the same DSH on another device</sub> |

<!-- Replace a placeholder with:
<img width="90%" src="docs/配图/imgs/overview.png" alt="CodingNS inside DSH: Agent picker, sessions, terminal, debug panel"> -->

## Acknowledgements

CodingNS's inspiration — and part of its implementation approach — comes from **[CodexHost](https://github.com/BytePioneer-AI/codex-host)**, which runs Pi, Claude Code, Grok Build and other Harnesses natively inside Codex Desktop. It showed the direction CodingNS follows from the other side: host *other* Harnesses as first-class Agents instead of replacing them. The multi-Harness adapter model, projecting a CLI event stream into native sessions, and keeping each Agent's sessions in the host sidebar and composer trace back to that design. Thanks to its authors and community — CodingNS is independent and not affiliated with CodexHost.

## What is CodingNS?

**DSH (DeepSeek Harness)** is DeepSeek's coding-agent harness — a CLI plus Web UI running an agent loop in your workspace. **CodingNS is a DSH plugin bundle** (Host + browser layers) adding seven modules, configured under **Settings → CodingNS**:

| Module (card label) | What it does | Default |
| --- | --- | :---: |
| **External Agent integration** `外部Agent集成` | Run installed Agent CLIs as native DSH sessions: streaming, tools, approvals, questions, usage, thinking levels | On |
| **Workspace session enhancement** `工作区会话增强` | Agent logos on session rows, archived-session entry, subscription/usage readout | Off |
| **Terminal enhancement** `终端强化` | Persistent terminals plus shell, theme, font, cursor, scrollback settings | Off · restart |
| **LAN access to DSH** `局域网访问DSH` | Listener forwarding a LAN address to the local DSH Web port | Always on |
| **Login protection** `登录保护` | One optional local account guarding LAN **and** relay access; loopback always allowed | Always on (card) |
| **Relay access service** `中转访问服务` | **Your DSH Web from anywhere on the internet**, end-to-end encrypted | Off |
| **Workspace debug** `工作区调试` | Per-workspace launch profiles, port checks, HTTP service proxy | On |

Nothing native is replaced — conversations, sessions, sidebar, settings and approvals stay DSH's own. Everything runs on the **Host** (your machine): Agents, terminals, files, LAN/relay listeners; the browser is only a view. Agent CLIs run as DSH child processes with their own credentials and providers, never through CodingNS. Remote paths are opt-in.

Notes: the sidebar terminal exists as soon as the plugin is installed — **Terminal enhancement** only switches it from a basic local PTY to the persistent backend (tmux on macOS/Linux, ConPTY on Windows) and applies on restart. On DSH `0.1.5.x` CodingNS runs in compatibility mode (no multi-tab or shell selection; session-row injection unverified) and the cards say so. The 调试 card is currently Chinese-only.

## Supported external Agents

Detected on the Host by command name; version and models come from the CLI itself. Detected Agents are enabled by default and can be toggled individually; the built-in **DeepSeek Harness** Agent is always available.

| Agent | id | Command(s) | Protocol | Capabilities |
| --- | --- | --- | --- | --- |
| Command Code | `command-code` | `command-code`, `commandcode`, `cmdc` | single-shot CLI | models, streaming, resume, interrupt, tools, thinking, usage |
| Claude Code | `claude-code` | `claude` | stream-json | models, streaming, resume, interrupt, tools, thinking, usage |
| Kimi CLI | `kimi` | `kimi`, `kimi-cli` | stream-json | all of the above + approvals, questions, steering |
| Gemini CLI | `gemini` | `gemini` | ACP | models, streaming, resume, interrupt, tools, thinking, usage, approvals |
| Pi Agent | `pi` | `pi`, `pi-agent` | JSON-RPC | models, streaming, resume, interrupt, tools, thinking, usage, steering |
| Codex | `codex` | `codex` | JSON-RPC (app-server) | all + approvals, questions, steering |
| OpenCode | `opencode` | `opencode`, or `OPENCODE_SERVER_URL` (default `http://127.0.0.1:4096`) | HTTP + SSE | all + approvals, questions |
| Grok Build | `grok` | `grok`, `grok-build` | ACP | models, streaming, tools, thinking, usage, approvals |

**models** model list · **streaming** live output · **resume** continue after restart · **interrupt** cancel a turn · **tools** tool calls in the conversation · **thinking** reasoning/effort · **usage** token or subscription limits · **approvals / questions** native DSH interactions · **steering** inject a message mid-turn. Unlisted capabilities are unsupported by that CLI or version. Install and log in to each Agent outside DSH; CodingNS never stores Agent credentials.

## Installation

**Requirements**: DSH inside `>=0.1.5-rc.3 <0.1.8-0` (plugin and DSH versions ship independently; the installer and runtime both refuse unsupported versions) · Node.js `>= 22.19` · `pnpm` on `PATH` (`dsh plugin` forwards to pnpm) · optional: Agent CLIs, and `tmux` on macOS/Linux for persistent terminals (`brew install tmux` / `sudo apt install tmux`).

CodingNS needs a profile that also contains the DSH Web application layer, so create the profile from the shipped `web` template first:

```bash
dsh codingns --from-default-profile web --dump-config   # create profile (prints layers, does not start)
dsh plugin --profile codingns add dsh-codingns@0.1.1    # install the bundle
dsh codingns                                            # start DSH
```

Or install into the standard web profile: `dsh plugin --profile web add dsh-codingns@0.1.1`, then `dsh web`.

- **Do not** create a fresh profile with the plugin as its first command: a new custom profile only contains `@deepseek-ai/dsh-base`, so the patch reports `entry "terminal-controller" not found` and there is no browser UI. Create it from the `web` template first.
- A registry 404 means that version is not published yet — use the source install below.

```bash
# verify
dsh plugin --profile codingns list --depth 0     # -> dsh-codingns <version>
dsh --profile codingns --dump-config             # expect id: dsh-codingns, terminal-controller disabled

# upgrade / pin / uninstall (restart DSH afterwards; settings are kept)
dsh plugin --profile codingns add dsh-codingns@<version>
dsh plugin --profile codingns remove dsh-codingns
```

**From source** (npm unavailable, or running a checkout):

```bash
git clone https://github.com/jingyi0605/DSH-CodingNS.git && cd DSH-CodingNS
pnpm install && pnpm build
dsh codingns --from-default-profile web --dump-config
dsh plugin --profile codingns add "$PWD"            # or: npm pack, then add ./dsh-codingns-0.1.1.tgz
```

A directory install links the checkout — rebuild (`pnpm build` / `pnpm dev:watch`) and restart DSH after changes.

**State on disk** — settings live in `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`) under `codingns:`: module switches, Agent enables/preferences, LAN mapping and login protection, terminal look, relay addresses.

| Path | Contents |
| --- | --- |
| `$DSH_HOME/profiles/<profile>` | Installed plugin packages and `dsh.profile.bundles` |
| `$DSH_HOME/dsh-codingns/` | Terminal `host-id` and `terminals.json` (restore mapping) |
| `~/.config/dsh-codingns/` | Relay credentials, DTLS identity, login-protection hash (`DSH_CODINGNS_STATE_DIR` overrides) |
| `<workspace>/.codingns/debug.json` | Debug launch profiles (mode `0600`, secrets rejected) |

## First run

1. `dsh codingns` opens the DSH Web UI.
2. **Settings → CodingNS**: review the module cards (restart-required ones show current and next-start state).
3. Install and log in to your Agent CLIs **outside** DSH, keep them on the Host `PATH`, then enable them in **外部Agent集成**.
4. Pick an Agent, model and thinking level in the composer and send a prompt — output streams into a native session with the Agent's logo.
5. Right sidebar: Terminal for a workspace shell (enable **终端强化** + restart for persistence); 调试 to add a launch profile and watch its port.
6. Remote use: set up [LAN access](#remote-access) or log in to the relay service. The account entry next to DSH's Settings button shows local login-protection and relay status, host CPU/memory and latency.

## Remote access

| | LAN access | Relay access service |
| --- | --- | --- |
| Connect from | Same local network | **Any device, anywhere on the internet** |
| Needs | Shared network + open listen port | Host can reach the Control API over HTTPS; your device can reach the CodingNS entry |
| Local port exposed | Yes — chosen interface/port (default `13080`) | No — isolated device tunnel |
| Account | Optional login protection | CodingNS account + bound Host |

**LAN** — pick a listen interface and port, auto-detect (or type) the local DSH Web port, start, then open `http://<lan-ip>:<port>`; auto-start restores the mapping. The module also patches `crypto.randomUUID`, which plain-HTTP LAN origins need.

**Login protection** (off by default; enable it on its card) — one local account guards LAN **and** relay access (default session timeout 30 minutes). Requests are filtered at the Host's forwarding boundary, so unauthenticated traffic never reaches DSH Web; `127.0.0.1` and `::1` are always allowed to prevent lockout. The password is `scrypt`-hashed in a `0600` file, and the browser only holds an `HttpOnly`, `SameSite=Strict` session cookie.

**Relay** — set the Control API (default `https://channel.codingns.com:1443`; register an account there), log in, refresh devices, bind the current Host (label, public key, fingerprint). Open the bound Host from any device via **`https://dsh.codingns.com`** (the card copies this address) — no public IP, port forwarding or VPN.

**Why the relay cannot read your DSH traffic** — the tunnel is end-to-end encrypted, so using it never hands your conversations to a server:

- Payload travels in a **WebRTC DataChannel protected by DTLS between the DSH Client and the DSH Host**; direct or via TURN, only ciphertext crosses the relay.
- The relay and control service handle **control-plane metadata only**: account/device records, Host binding, tickets, SDP/ICE signaling, online state, traffic accounting.
- Each Host keeps its own DTLS certificate (`~/.config/dsh-codingns/dtls-identity.json`) and publishes a SHA-256 fingerprint the remote side verifies during the handshake — a mismatch aborts the connection (`Host DTLS fingerprint 校验失败`) instead of accepting a substituted certificate; the same fingerprint shows in the relay card for manual comparison.
- Passwords are used only for login requests; refresh token and device credential stay on the Host. Diagnostics log protocol metadata only (direction, type, stream id, status, bytes) — never bodies, tickets, cookies or DSH Web content.

## Troubleshooting

- **Versions** — `dsh --version`, `dsh plugin --profile codingns list --depth 0`, `npm view dsh-codingns version`. Install and startup both reject DSH outside the supported range; upgrade or downgrade DSH instead of mixing versions.
- **`patch: entry "terminal-controller" not found`** — the profile lacks the Web app layer; recreate it from the `web` template as shown above.
- **Agent not detected** — run `<cli> --version` on the Host, ensure its directory is on the `PATH` of the process that started DSH (GUI launchers often differ), log in with the vendor tool, then restart DSH.
- **Terminal** — persistent mode needs `tmux` on macOS/Linux; enabling/disabling the module and changing the binding scope need a restart; terminals are addressed per workspace.
- **LAN** — check the card's forwarding line, allow the port through the firewall, keep both devices on one network; when several DSH instances run, pick the detected port manually. If login protection is on, sign in or temporarily use the loopback address.
- **Relay** — verify Control API reachability, log in again if the session expired, refresh devices, then bind the Host.
- **Logs** — `DSH_CODINGNS_TUNNEL_DEBUG=1 dsh codingns --no-open` (metadata only); pnpm install logs in `$DSH_HOME/profiles/<profile>/.plugin-manager/logs/`.
- **Reporting** — include DSH and CodingNS versions, OS, module and exact error: [GitHub Issues](https://github.com/jingyi0605/DSH-CodingNS/issues) or QQ **1092985965**.

## Development

Node `>= 22.19` + pnpm: `pnpm install` → `pnpm build` (version check → tsc → client + H5 bundles) → `pnpm test` (58 suites) → `pnpm typecheck`. Dev loop: `pnpm dev:watch` with `pnpm dev:link <profile>`, then restart DSH. Versions come from `version.json` (`version:set-plugin` / `version:set-dsh`, guarded by `version:check`). Layout: `src/host` (Host layer), `src/client` (browser layer), `src/shared/contracts`, `src/transport` (tunnel + WebRTC), `src/features` (module registry), `tests/`, `specs/`, `docs/`, `data/build/` (git-ignored). A `v*` tag runs GitHub Actions (tag/version check, frozen install, typecheck, tests, `npm pack`) and publishes with provenance; prereleases get the `next` dist-tag. Roadmap: PeerHost, file management, workspace sessions, debug-proxy completion (auth + WebSocket), Git, SKILL, more. Screenshots for this README: see the [shot list](docs/配图/20260925-README配图清单.md).

---

## 中文说明

[返回 English](#codingns-for-deepseek-harness)

### 鸣谢

CodingNS 的项目灵感与部分实现思路来自 **[CodexHost](https://github.com/BytePioneer-AI/codex-host)**——它把 Pi、Claude Code、Grok Build 等 Harness 原生跑在 Codex Desktop 里，展示了 CodingNS 从另一侧沿用的方向：**把其他 Harness 作为一等 Agent 接入**，而不是替换它们。多 Harness 适配器模型、把 CLI 事件流投影为宿主原生会话、让每个 Agent 的会话留在宿主侧栏与输入框，都源自该项目的设计。感谢其作者与社区；CodingNS 是独立项目，与 CodexHost 无隶属关系。

### 界面预览

> 🖼️ **待补图** `docs/配图/imgs/overview.png` —— 同一窗口内的 Agent 选择器、带 Logo 的会话列表、持久终端与 **调试** 面板。*建议 1600×900；清单见 [README 配图清单](docs/配图/20260925-README配图清单.md)*

| | |
| --- | --- |
| 🖼️ `docs/配图/imgs/agent-picker.png`<br><sub>输入框：Agent、模型、思考强度</sub> | 🖼️ `docs/配图/imgs/sessions.png`<br><sub>会话行：Agent Logo、归档入口、用量</sub> |
| 🖼️ `docs/配图/imgs/terminal.png`<br><sub>重启后恢复的侧栏终端</sub> | 🖼️ `docs/配图/imgs/debug.png`<br><sub>调试面板：启动配置、端口、代理</sub> |
| 🖼️ `docs/配图/imgs/settings.png`<br><sub>设置 → CodingNS 模块卡片</sub> | 🖼️ `docs/配图/imgs/relay.png`<br><sub>中转卡片 + 在另一台设备打开同一个 DSH</sub> |

### 项目简介

**DSH（DeepSeek Harness）** 是 DeepSeek 的编码 Agent 运行框架，由 CLI 和 Web 界面组成，在 Workspace 中运行 Agent 循环。**CodingNS 是一个 DSH 插件 Bundle**（Host 层 + 浏览器层），提供七个模块，全部在 **设置 → CodingNS** 中配置：

| 模块（卡片名称） | 作用 | 默认 |
| --- | --- | :---: |
| **外部Agent集成** | 把已安装的 Agent CLI 变成 DSH 原生会话：流式输出、工具、权限确认、提问、用量、思考强度 | 开 |
| **工作区会话增强** | 会话行显示 Agent Logo、归档会话入口、订阅/用量信息 | 关 |
| **终端强化** | 持久终端，以及 Shell、主题、字体、光标、滚动缓冲区 | 关 · 需重启 |
| **局域网访问DSH** | 监听端口并把局域网地址转发到本机 DSH Web | 常驻 |
| **登录保护** | 可选：用统一的本地账号保护局域网**和**中继访问；本机回环地址始终放行 | 常驻（卡片） |
| **中转访问服务** | **在互联网任何位置访问自己的 DSH Web**，端到端加密 | 关 |
| **工作区调试** | 按工作区保存启动配置、检查端口、HTTP 服务代理 | 开 |

DSH 原生部分不会被替换：对话、会话列表、侧栏、设置、权限确认仍是 DSH 自己的组件。一切都跑在 **Host（你的机器）** 上——Agent 进程、终端、文件、局域网/中继监听；浏览器只是视图。Agent CLI 作为 DSH 子进程使用自己的凭据与上游，不经过 CodingNS；远程访问全部可选。

补充：插件装好后侧栏终端就已存在，**终端强化** 只是把它从基础本地 PTY 切换为持久后端（macOS/Linux 用 tmux，Windows 用 ConPTY），重启后生效。在 DSH `0.1.5.x` 上 CodingNS 运行于兼容模式（无多 Tab 与 Shell 选择，会话行注入未验证），卡片会给出提示。**工作区调试** 目前界面文案只有中文。

### 支持的外部 Agent

在 Host 上按命令名检测，版本与模型列表从 CLI 自身读取；检测到的 Agent 默认启用，可单独启停；内置 **DeepSeek Harness** Agent 始终可用。

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

**模型** 模型列表 · **流式** 实时输出 · **恢复** 重启后继续 · **打断** 取消当前回合 · **工具** 对话中渲染工具调用 · **思考** 推理/思考强度 · **用量** token 或订阅额度 · **权限确认 / 提问** 变成 DSH 原生交互 · **插话** 回合中追加消息。未列出的能力表示该 CLI 或其版本不支持。Agent 的安装与登录都在 DSH 之外完成，CodingNS 不保存 Agent 凭据。

### 安装

**环境要求**：DSH 在 `>=0.1.5-rc.3 <0.1.8-0` 范围内（插件与 DSH 版本独立发布，安装期与运行期都会拒绝不兼容版本）· Node.js `>= 22.19` · `PATH` 中有 `pnpm`（`dsh plugin` 转发给 pnpm）· 可选：Agent CLI，以及 macOS/Linux 上用于持久终端的 `tmux`（`brew install tmux` / `sudo apt install tmux`）。

CodingNS 需要 Profile 同时包含 DSH Web 应用层，因此先用官方 `web` 模板创建 Profile：

```bash
dsh codingns --from-default-profile web --dump-config   # 创建 Profile（只打印层结构，不启动）
dsh plugin --profile codingns add dsh-codingns@0.1.1    # 安装 Bundle
dsh codingns                                            # 启动 DSH
```

也可直接装进标准 `web` Profile：`dsh plugin --profile web add dsh-codingns@0.1.1`，然后 `dsh web`。

- **不要**把 `dsh plugin --profile <新名字> add …` 当作新 Profile 的第一条命令：全新自定义 Profile 只含 `@deepseek-ai/dsh-base`，会报 `entry "terminal-controller" not found` 且没有浏览器界面；请先用 `web` 模板创建。
- npm 返回 404 说明该版本还没发布，请改用下面的源码安装。

```bash
# 验证
dsh plugin --profile codingns list --depth 0     # -> dsh-codingns <版本>
dsh --profile codingns --dump-config             # 应看到 id: dsh-codingns，terminal-controller 为 disabled

# 升级 / 固定版本 / 卸载（之后重启 DSH，设置会保留）
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

**磁盘状态** —— 设置保存在 `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`）的 `codingns:` 命名空间：模块开关、Agent 启停与偏好、局域网映射与登录保护、终端外观、中转地址。

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/profiles/<profile>` | 已安装的插件包与 `dsh.profile.bundles` |
| `$DSH_HOME/dsh-codingns/` | 终端 `host-id` 与 `terminals.json`（恢复映射） |
| `~/.config/dsh-codingns/` | 中转凭据、DTLS 身份、登录保护哈希（可用 `DSH_CODINGNS_STATE_DIR` 覆盖） |
| `<工作区>/.codingns/debug.json` | 调试启动配置（权限 `0600`，拒绝保存密钥） |

### 首次使用

1. `dsh codingns` 打开 DSH Web 界面。
2. 打开 **设置 → CodingNS** 查看模块卡片（需重启的模块会同时显示当前生效状态与下次启动目标）。
3. 在 DSH **之外** 安装并登录 Agent CLI，确保命令在 Host 的 `PATH` 中，然后在 **外部Agent集成** 中启用。
4. 在输入框选择 Agent、模型和思考强度并发送消息——输出流式写入原生会话，并带 Agent Logo 出现在侧栏。
5. 右侧栏：终端面板为当前工作区开终端（要持久化请启用 **终端强化** 后重启）；**调试** 面板添加启动配置并查看端口。
6. 需要远程使用时，配置 [局域网访问](#远程访问) 或登录中转服务。DSH 设置按钮旁的账户入口会显示登录保护/中继状态、Host CPU/内存与延迟。

### 远程访问

| | 局域网访问 | 中转访问服务 |
| --- | --- | --- |
| 从哪里连接 | 同一局域网 | **任何设备、互联网上的任何位置** |
| 前提 | 同一网络 + 放行监听端口 | Host 能通过 HTTPS 访问 Control API；你的设备能连上 CodingNS 入口 |
| 是否暴露本地端口 | 是——所选网卡/端口（默认 `13080`） | 否——独立设备隧道 |
| 账号 | 可选登录保护 | 需要 CodingNS 账号并绑定 Host |

**局域网** —— 选择监听网卡与端口，自动探测（或手动填写）本机 DSH Web 端口，启动后在另一台设备打开 `http://<局域网 IP>:<端口>`；开启自动启动可恢复映射。模块还会补齐明文 HTTP 局域网来源所需的 `crypto.randomUUID`。

**登录保护**（默认关闭，在卡片中开启）—— 用统一的本地账号保护局域网**和**中继访问（默认会话超时 30 分钟）。认证发生在 Host 的转发边界：未登录请求不会到达 DSH Web；`127.0.0.1` 与 `::1` 永远放行，避免把自己锁在外面。密码以 `scrypt` 哈希保存在 `0600` 文件中，浏览器只持有 `HttpOnly`、`SameSite=Strict` 会话 Cookie。

**中转** —— 配置 Control API（默认 `https://channel.codingns.com:1443`，可在此注册账号），登录、刷新设备、绑定当前 Host（显示标签、公钥、指纹）。之后在任意设备通过 **`https://dsh.codingns.com`**（卡片可一键复制该地址）打开已绑定的 Host：不需要公网 IP、端口映射或 VPN。

**为什么中转看不到你的 DSH 内容**——隧道端到端加密，使用它不等于把对话交给服务器：

- 载荷走在 **DSH Client 与 DSH Host 之间的 WebRTC DataChannel，由 DTLS 保护**；无论直连还是经 TURN，Relay 都只承载密文。
- Relay 与控制站只处理**控制面元数据**：账号/设备记录、Host 绑定、ticket、SDP/ICE 信令、在线状态、流量统计。
- 每个 Host 自持 DTLS 证书（`~/.config/dsh-codingns/dtls-identity.json`）并发布 SHA-256 指纹，远端在握手时核对；不一致直接中断（`Host DTLS fingerprint 校验失败`），不会接受被替换的证书；同一指纹显示在中转卡片中供人工比对。
- 密码只用于登录请求；refresh token 与设备凭据留在 Host。诊断日志只记录协议元数据（方向、类型、流 ID、状态、字节数），不记录正文、票据、Cookie 或 DSH Web 内容。

### 故障排查

- **版本** —— `dsh --version`、`dsh plugin --profile codingns list --depth 0`、`npm view dsh-codingns version`；安装与启动都会拒绝范围外的 DSH，请升级或降级 DSH，不要混用版本。
- **`patch: entry "terminal-controller" not found`** —— Profile 缺少 Web 应用层，按上文用 `web` 模板重建。
- **检测不到 Agent** —— 在 Host 上执行 `<cli> --version`；确认其目录在启动 DSH 的进程的 `PATH` 中（图形启动器常不同）；用各家工具登录后重启 DSH。
- **终端** —— macOS/Linux 持久模式需要 `tmux`；启停模块与修改绑定范围需重启；终端按工作区寻址。
- **局域网** —— 确认卡片转发信息、防火墙放行、两台设备同网络；多个 DSH 实例时手动选择探测到的端口；开启登录保护后需先登录，或临时用回环地址访问。
- **中转** —— 检查 Control API 可达性，会话过期则重新登录，刷新设备后绑定 Host。
- **日志** —— `DSH_CODINGNS_TUNNEL_DEBUG=1 dsh codingns --no-open`（仅元数据）；pnpm 安装日志在 `$DSH_HOME/profiles/<profile>/.plugin-manager/logs/`。
- **反馈** —— 附上 DSH 与 CodingNS 版本、操作系统、涉及模块和完整错误：[GitHub Issues](https://github.com/jingyi0605/DSH-CodingNS/issues) 或 QQ **1092985965**。

### 开发

需要 Node `>= 22.19` 与 pnpm：`pnpm install` → `pnpm build`（版本校验 → tsc → Client + H5 Bundle）→ `pnpm test`（58 个测试套件）→ `pnpm typecheck`。开发循环：`pnpm dev:watch` 配合 `pnpm dev:link <profile>`，然后重启 DSH。版本源是 `version.json`（`version:set-plugin` / `version:set-dsh`，由 `version:check` 守卫）。目录：`src/host`（Host 层）、`src/client`（浏览器层）、`src/shared/contracts`、`src/transport`（隧道与 WebRTC）、`src/features`（模块注册表）、`tests/`、`specs/`、`docs/`、`data/build/`（已忽略）。推送 `v*` tag 触发 GitHub Actions（tag/版本校验、冻结安装、类型检查、测试、`npm pack`）并以 provenance 发布，预发布版本用 `next` dist-tag。路线图：PeerHost、文件管理、工作区会话、调试代理完善（鉴权 + WebSocket）、Git、SKILL、更多。README 配图见 [配图清单](docs/配图/20260925-README配图清单.md)。
