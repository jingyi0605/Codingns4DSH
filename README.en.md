<div align="center">

# CodingNS for DeepSeek Harness

**Use multiple coding Agents, manage projects, talk with your assistant, and access your DSH workbench remotely.**

[![npm version](https://img.shields.io/npm/v/%40jingyi0605%2Fcodingns4dsh?logo=npm)](https://www.npmjs.com/package/@jingyi0605/codingns4dsh)
[![DSH compatibility](https://img.shields.io/badge/DSH-0.2.1--alpha.1-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-3C873A?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/gpl-3.0.html)

[简体中文](README.md) · **English**

**Current release `@jingyi0605/codingns4dsh@0.2.1-beta.6`** · DSH **`>=0.2.0-rc.2 <=0.2.1-alpha.1`** (tested with `0.2.1-alpha.1`) · Node **`>= 22.19`** · macOS / Linux / Windows

**[GitHub](https://github.com/jingyi0605/Codingns4DSH)** · **[npm](https://www.npmjs.com/package/@jingyi0605/codingns4dsh)** · **QQ group 1092985965** · **[WeChat / QQ QR codes](#community)**

<p>
  <a href="#interface-preview">Preview</a> ·
  <a href="#what-is-codingns4dsh">What it is</a> ·
  <a href="#supported-agents">Agents</a> ·
  <a href="#features">Features</a> ·
  <a href="#installation">Install</a> ·
  <a href="#first-run">First run</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#community">Community</a> ·
  <a href="#development">Development</a> ·
  <a href="#acknowledgements">Acknowledgements</a> ·
  <a href="#license">License</a>
</p>

</div>

## Interface Preview

<div align="center">
  <img width="100%" src="assets/screenshots/workspace-overview.jpg" alt="The CodingNS workbench and the Git sidebar">
</div>

The CodingNS workbench brings the conversation, Agent picker and Git sidebar together in one view.

---

## What is Codingns4DSH

**Codingns4DSH** is a plugin for [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) that brings coding Agents, project tools and a personal assistant into one workbench. Manage all modules in **Settings → Codingns4DSH**.

| Module | What you can do | Default |
| --- | --- | :---: |
| **External Agent integration** | Use coding Agents in DSH, switch models and follow their work | On |
| **Workspace session enhancement** | Identify Agents, manage archived sessions and view subscription usage | Off |
| **Mobile access enhancements** | Use a mobile layout, sidebar gestures, home-screen access and notifications | On |
| **Terminal enhancement** | Use persistent terminals and customize their appearance | Off |
| **LAN access to DSH** | Open your workbench from other devices on the same network | Always available |
| **Login protection** | Require a login for LAN and relay access | Off |
| **Relay access service** | Access DSH over the internet with end-to-end encryption | Off |
| **Workspace debug** | Save launch profiles, manage processes, check ports and access services | On |
| **Git repository management** | Review changes, stage, commit, switch branches and browse history | On |
| **File management enhancement** | Create, edit, rename, move, copy and delete files | Off |
| **PeerHost workbench** | Use other DSH Hosts' workspaces and sessions in your current workbench | Off |
| **Global assistant (experimental)** | Chat by text or voice, follow project progress and customize your assistant | Off |

Agents, terminals and project files run on the computer hosting DSH (the Host). The browser provides a shared interface, with remote access available when needed.

---

## Supported Agents

Detected on the Host by command name; version and models come from the CLI itself. Detected Agents are enabled by default and can be toggled individually. The built-in **DeepSeek Harness** Agent is always available.

| Agent | id | Command | Protocol | Capabilities | Notes |
| --- | --- | --- | --- | --- | --- |
| Command Code | `command-code` | `command-code`, `commandcode`, `cmdc` | CLI + ACP | models, streaming, resume, interrupt, tools, thinking, usage, approvals, questions | The formal Host runtime uses `cmd acp`; DSH permissions map to `--plan`, `--permission-mode accept-edits`, or `--yolo`, and questions return through Command Code's `session/request_permission` extension |
| Claude Code | `claude-code` | `claude` | stream-json | models, streaming, resume, interrupt, tools, thinking, usage, approvals, questions | `can_use_tool` approvals and `AskUserQuestion` |
| Kimi CLI | `kimi` | `kimi`, `kimi-cli` | stream-json | all of the above + approvals, questions, steering | — |
| Gemini CLI | `gemini` | `gemini` | ACP | models, streaming, resume, interrupt, tools, thinking, usage, approvals, questions | ACP permissions and form elicitation |
| Pi Agent | `pi` | `pi`, `pi-agent` | JSON-RPC | models, streaming, resume, interrupt, tools, thinking, usage, steering | No verifiable DSH approval/question response wire in the current protocol |
| Codex | `codex` | `codex` | JSON-RPC (app-server) | all + approvals, questions, steering | app-server enables `request_user_input`; DSH renders the native question panel |
| OpenCode | `opencode` | `opencode`, or `OPENCODE_SERVER_URL` (default `http://127.0.0.1:4096`) | HTTP + SSE | all + approvals, questions | — |
| Grok Build | `grok` | `grok`, `grok-build` | ACP | models, streaming, tools, thinking, usage, approvals, questions | ACP permissions plus Grok's private `x.ai/ask_user_question` structured question method |
| MiniMax Code | `mcode` | `mcode` | ACP / stream-json | models, streaming, resume, interrupt, tools, thinking, usage, approvals, questions | Interactive requests use ACP; the explicit-effort `exec` path has no interactive response wire |
| ZCode | `zcode` | `zcode`, bundled desktop runtime | JSON-RPC bare envelope | models, streaming, resume, interrupt, usage | No verifiable DSH approval/question response wire |
| CodeBuddy (auto-detects CN/international) | `codebuddy` | `codebuddy`, `codebuddy-code`, `cbc`, and Windows `.cmd` entry points; region selected from environment and auth domain | ACP (`--acp`) | models, streaming, resume, interrupt, tools, thinking, usage, approvals, questions | Supports stdio ACP and HTTP sidecar ACP |
| WorkBuddy | `workbuddy` | `codebuddy` bundled in the WorkBuddy desktop app | ACP (`--acp`) | models, streaming, resume, interrupt, tools, thinking, approvals, questions | Permissions and form elicitation use the HTTP ACP sidecar |
| Cursor CLI | `cursor-cli` | `cursor-agent`, `agent` | ACP (`acp`) | models, streaming, resume, interrupt, tools, thinking, approvals, questions | Standard ACP permissions and form elicitation |
| Kiro CLI | `kiro-cli` | `kiro-cli` | ACP (`acp --agent-engine v3 --auth-method cli`) | models, streaming, resume, interrupt, tools, thinking, approvals, questions | Standard ACP permissions and form elicitation |
| Qoder | `qoder` | `qoder`, `qodercli` | ACP (`--acp`) | models, streaming, resume, interrupt, tools, thinking, approvals, questions | Standard ACP permissions and form elicitation |
| Qoder CN | `qoder-cn` | `qodercn`, `qoderclicn` | ACP (`--acp`) | models, streaming, resume, interrupt, tools, thinking, approvals, questions | Standard ACP permissions and form elicitation |
| Antigravity | `antigravity` | `agy` | stream-json (stdin NDJSON) | models, streaming, resume, interrupt, tools, thinking | Permission state maps to CLI safety modes; no interactive approval/question wire |

**models** model list · **streaming** live output · **resume** continue after restart · **interrupt** cancel a turn · **tools** tool calls in the conversation · **thinking** reasoning/effort · **usage** token or subscription limits · **approvals / questions** native DSH interactions · **steering** inject a message mid-turn.

Unlisted capabilities are unsupported by that CLI or version. Install and log in to each Agent outside DSH; Codingns4DSH never stores Agent credentials.

Approvals and questions are rendered by DSH's native components. The Web Client Bundle must inject `@deepseek-ai/dsh-client-ui-user-questions`; otherwise the Host may receive a question event without having a question panel to mount. Adapters with an interactive response wire normalize Provider requests into `permission-request` or `question-request` events, pass them to the native approval/question components, then send the typed answer back with the Provider's original request ID. ACP adapters use the standard `session/request_permission` and `elicitation/create` form requests; Grok Build's `grok_build/ask_user_question` tool call returns through the private `x.ai/ask_user_question` method with an `outcome`; Command Code's `ask_user_question` also uses `session/request_permission`, distinguished by `toolCall.kind=other` and `toolCall.rawInput.question/options`. Fixed choices are returned using the original `optionId`; free text is carried in ACP `_meta["codingns/questionAnswer"]` and returned to the Command Code tool through a Node loader that only affects the child process memory and does not modify the user's installed package. The Codex app-server explicitly enables `default_mode_request_user_input` so it emits `item/tool/requestUserInput` requests. URL elicitation requires a browser security-consent flow and is not advertised. Antigravity only maps DSH permission state to CLI safety modes.

---

## Features

### External Agent Integration

Choose an Agent and model to start coding. Replies, tool calls, approvals and questions appear directly in the DSH conversation. Model and thinking preferences are remembered per Agent, and you can delegate tasks to other connected Agents.

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/agent-picker.jpg" alt="Workspace session enhancement with Agent logos and archived sessions"></td>
      <td><img width="100%" src="assets/screenshots/model-picker.jpg" alt="The Codex model list"></td>
    </tr>
  </table>
</div>

### Session Enhancement and Usage

Identify sessions by Agent icons, access archived conversations, and hide or restore workspaces. Supported Agents can show subscription allowances, reset times, usage and costs.

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/subscription-usage.jpg" alt="Codex upstream usage and cost statistics"></td>
      <td><img width="100%" src="assets/screenshots/subscription-plan.jpg" alt="Codex subscription allowance and reset time"></td>
    </tr>
  </table>
</div>

### Global Assistant (Experimental)

Create a personal assistant with your choice of name, personality, model and avatar. Open the same workbench from the sidebar or floating avatar.

- **Continuous conversations**: text and live voice share one history, so you can switch input methods and keep talking.
- **Project follow-up**: check progress in selected projects, look up sessions and send follow-up messages at your request.
- **Web search**: use your configured DSH search service for weather, news and other current information.
- **Attachments**: ask about images and text files; image understanding requires a vision-capable model.
- **Avatars and voices**: use built-in or third-party avatars, customize portraits and voices, and keep calls in a floating view with captions and mute controls.

Browser speech playback is the default, with local MOSS speech available as an option. The assistant handles conversation and coordination; it does not execute commands or edit code directly.

### Terminals and Log Sharing

The sidebar terminal is available after installation. Enable **Terminal enhancement** and restart DSH for persistent terminals. Terminals are shared within a workspace and retain their state when switching sessions.

Attach terminal output or selected logs to a new or existing conversation to ask an Agent for help.

### Workspace Debug

Save launch profiles for each project, start or stop processes, check port status and access project HTTP services through DSH. The debug panel currently has a Chinese-only interface.

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/workspace-debug.jpg" alt="Workspace debug panel: launch profiles, port state and proxy"></td>
      <td><img width="100%" src="assets/screenshots/workspace-debug-edit.jpg" alt="Workspace debug panel: edit a launch profile"></td>
    </tr>
  </table>
</div>

### Git Repository Management

Initialize repositories, review changes, stage or unstage files, commit, switch branches and browse history from the right sidebar.

### File Management Enhancement

Create, edit, rename, move, copy or delete files and directories directly in the file sidebar.

### PeerHost Workbench

Add other DSH Hosts on your LAN to access their workspaces, sessions, files, Git and terminals from the current workbench. Hosts remain independent, so a disconnected peer does not interrupt local work. PeerHost aggregation through the relay service is not currently supported.

### Mobile Access

Read conversations, send messages and use workspace tools on your phone. Swipe to open or close sidebars, add the app to your home screen, and use notifications in supported browsers.

### Modules and Settings

Enable the features you need and configure them in their module cards. Settings that require a restart are clearly marked.

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/settings-overview.jpg" alt="Settings → Codingns4DSH module cards"></td>
      <td><img width="100%" src="assets/screenshots/settings-modules.jpg" alt="All module switches"></td>
    </tr>
  </table>
</div>

### Login Protection

Set a shared local account for LAN and relay access to protect your remote workbench. Local access remains available.

<div align="center">
  <img width="70%" src="assets/screenshots/login-protection.jpg" alt="Local account login page">
</div>

### Remote Access

| Method | Best for | How to connect |
| --- | --- | --- |
| **LAN access** | Computers, phones or tablets on the same network | Enable the mapping and copy the access URL |
| **Relay access** | Reaching your workbench while away | Sign in to the relay service and bind your Host |

The relay needs no public IP, port forwarding or VPN. Register at the [Codingns4DSH relay platform](https://channel.codingns.com:1443), then connect to a bound Host from the [remote workbench](https://dsh.codingns.com). Connections are end-to-end encrypted, so the relay cannot read conversation content.

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/relay-service.jpg" alt="Relay access card"></td>
      <td><img width="100%" src="assets/screenshots/relay-h5-login.jpg" alt="H5 login page: choose a DSH Host"></td>
    </tr>
  </table>
</div>

<div align="center">
  <img width="70%" src="assets/screenshots/relay-status.jpg" alt="Account status popover: access path, latency, CPU and memory">
</div>

The account menu shows login status, access method, connection latency and Host load.

---

## Installation

**Requirements**: DSH `>=0.2.0-rc.2 <=0.2.1-alpha.1` (tested with `0.2.1-alpha.1`), Node.js `>=22.19`, and pnpm. Persistent terminals on macOS/Linux also require tmux.

### Use the Built-in Web Profile

```bash
dsh plugin --profile web add @jingyi0605/codingns4dsh@0.2.1-beta.6
dsh web
```

### Optional: Use a Separate Profile

Create a separate environment from the built-in Web profile:

```bash
dsh codingns --from-default-profile web --dump-config
dsh plugin --profile codingns add @jingyi0605/codingns4dsh@0.2.1-beta.6
dsh codingns
```

Restart an existing DSH instance after installation or upgrade. To upgrade, replace the version in the install command with your target version. To uninstall, run `dsh plugin --profile web remove @jingyi0605/codingns4dsh`; replace `web` with your profile name when using a separate profile.

---

## First Run

1. Open **Settings → Codingns4DSH** and enable the modules you need.
2. Install and sign in to an Agent on the DSH Host, then choose the Agent and model in the composer.
3. Use the right sidebar for terminals, Git, files and workspace debugging.
4. Enable the global assistant, create your character and start chatting; prepare voice resources in voice settings for live calls.
5. For access from other devices, configure LAN or relay access and enable login protection as needed.

---

## Troubleshooting

- **Installation fails**: check the required DSH, Node.js and plugin versions; create separate profiles from the Web template.
- **Agent not detected**: make sure it is installed, signed in, and its command is available to the process running DSH.
- **Terminal is not persistent**: enable Terminal enhancement and restart DSH; macOS/Linux require tmux.
- **Voice unavailable**: check resource status in voice settings and allow browser microphone access.
- **Remote connection fails**: check the network and firewall for LAN access, or login status and Host binding for relay access.

When reporting an issue, include DSH and plugin versions, your OS and the full error: [GitHub Issues](https://github.com/jingyi0605/Codingns4DSH/issues) or the [community groups](#community).

---

## Community

The WeChat and QQ groups are for questions, feedback and release announcements — scan either code to join.

<div align="center">
  <table>
    <tr>
      <td align="center" width="50%">
        <img width="300" src="assets/screenshots/wechat-group.png" alt="WeChat group QR code: DSH-插件交流群"><br>
        <b>WeChat group</b>: DSH-插件交流群
      </td>
      <td align="center" width="50%">
        <img width="300" src="assets/screenshots/qq-group.png" alt="QQ group QR code: 1092985965"><br>
        <b>QQ group</b>: 1092985965
      </td>
    </tr>
  </table>
</div>

The WeChat QR code is generated dynamically by WeChat and is **valid for 7 days** (this image was captured on 2026-10-08 and states it expires on October 15); re-open the group's share page for a fresh code once it lapses, or ask in [GitHub Issues](https://github.com/jingyi0605/Codingns4DSH/issues). The QQ group QR code and group number do not expire.

---

## Development

Use a separate Stage0 environment for source development and follow the [project rules](AGENTS.md) (Chinese). Build, test and type-check commands:

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

Source links and development runs are for Stage0 only. Desktop uses published versions, not source links or local development packages. See the [Stage0 development notes](docs/开发记录/20261007-Stage0自动编译与热重载接入记录.md) (Chinese) for setup.

Design and implementation details live in the [specifications](specs/), [development records](docs/开发记录/) and [development guidelines](docs/开发规范/) (Chinese). The [avatar catalog](assets/assistant-avatar-catalog.md) and [screenshot list](assets/screenshots/README.md) are also available separately.

---

## Acknowledgements

The inspiration for Codingns4DSH — and part of its implementation approach — comes from **[CodexHost](https://github.com/BytePioneer-AI/codex-host)**, which runs Pi, Claude Code, Grok Build and other Harnesses natively inside Codex Desktop. It showed the direction Codingns4DSH follows from the other side: host *other* Harnesses as first-class Agents instead of replacing them. The multi-Harness adapter model, projecting a CLI event stream into native sessions, and keeping each Agent's sessions in the host sidebar and composer trace back to that design. Thanks to its authors and community.

Codingns4DSH is an independent project and is not affiliated with CodexHost.

---

## License

Released under the **GNU General Public License version 3 or later** (`GPL-3.0-or-later`). See [LICENSE](LICENSE) for the full terms.

Copyright (C) 2026 jingyi0605
