<div align="center">

# CodingNS for DeepSeek Harness

**Use multiple coding Agents, manage projects, talk with your assistant, and access your DSH workbench remotely.**

[![npm version](https://img.shields.io/npm/v/%40jingyi0605%2Fcodingns4dsh?logo=npm)](https://www.npmjs.com/package/@jingyi0605/codingns4dsh)
[![DSH compatibility](https://img.shields.io/badge/DSH-0.2.1--alpha.1-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-3C873A?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/gpl-3.0.html)

[简体中文](README.md) · **English**

**Current release `@jingyi0605/codingns4dsh@0.2.1-beta.7`** · DSH **`>=0.2.0-rc.2 <=0.2.1-alpha.1`** (tested with `0.2.1-alpha.1`) · Node **`>= 22.19`** · macOS / Linux / Windows

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

Install and sign in to an Agent with its own tools, and Codingns4DSH will detect it. The built-in **DeepSeek Harness** Agent remains available. Choose models and view streaming replies in one interface, with session resume, tool calls and thinking controls where supported.

The table highlights selected capabilities; availability depends on the Agent and its version. Skills are reusable workflows, and steering lets you add a message while an Agent is working.

| Agent | Key capabilities | Notes |
| --- | --- | --- |
| **Command Code** | Skills, approvals, questions, usage | Uses DSH permission settings and the native question panel |
| **Claude Code** | Skills, approvals, questions, usage | Supports native skill discovery and invocation |
| **Kimi CLI** | Approvals, questions, steering, usage | — |
| **Gemini CLI** | Approvals, questions, usage | Supports native approvals and form questions |
| **Pi Agent** | Steering, thinking controls, usage | DSH approval and question responses remain unverified in the current protocol |
| **Codex** | Approvals, questions, steering, usage | Questions appear in DSH's native question panel |
| **OpenCode** | Skills, approvals, questions, usage | Supports a local CLI or existing server, plus native skills |
| **Grok Build** | Skills, approvals, questions, usage | Supports native skill discovery and structured questions |
| **MiniMax Code** | Approvals, questions, usage | Default integration supports interaction; explicit-effort execution does not return interactive responses.<br>Upstream contributor: [chenjunyi000](https://github.com/chenjunyi000)<br>PRs [#6](https://github.com/jingyi0605/Codingns4DSH/pull/6), [#7](https://github.com/jingyi0605/Codingns4DSH/pull/7) |
| **ZCode** | Model selection, session resume, usage | Uses the CLI or the desktop app's bundled runtime.<br>Upstream contributor: [chenjunyi000](https://github.com/chenjunyi000)<br>PRs [#6](https://github.com/jingyi0605/Codingns4DSH/pull/6), [#7](https://github.com/jingyi0605/Codingns4DSH/pull/7) |
| **CodeBuddy** | Approvals, questions, usage | Automatically detects CN/international editions.<br>CodexHost contributor: [mouzhi](https://github.com/mouzhi)<br>Initial integration: [f30b000](https://github.com/BytePioneer-AI/codex-host/commit/f30b000f88950c40844b071eec2f6f385c6bcb49) |
| **WorkBuddy** | Approvals, questions, thinking controls | Uses the WorkBuddy desktop app's bundled runtime.<br>CodexHost contributor: [BytePioneer-AI (ChongWen)](https://github.com/BytePioneer-AI)<br>Initial integration: [6e9f365](https://github.com/BytePioneer-AI/codex-host/commit/6e9f365e2bf8ac61716f8250475530ae790f2d2f) |
| **Cursor CLI** | Approvals, questions, thinking controls | CodexHost contributor: [mouzhi](https://github.com/mouzhi)<br>Initial integration: [ad6ba8e](https://github.com/BytePioneer-AI/codex-host/commit/ad6ba8e04d294c473d2dcad99880496ff39c1f7e) |
| **Kiro CLI** | Approvals, questions, thinking controls | CodexHost contributor: [gy212](https://github.com/gy212)<br>Initial integration: [79675cd](https://github.com/BytePioneer-AI/codex-host/commit/79675cdbfdc042eb37a849c3eb1539e9efc40a0d) |
| **Qoder** | Approvals, questions, thinking controls | CodexHost contributors: [gy212](https://github.com/gy212), [BytePioneer-AI (ChongWen)](https://github.com/BytePioneer-AI)<br>PR #289 merge: [8926130](https://github.com/BytePioneer-AI/codex-host/commit/8926130af1426a467747b66d8d2dbf68f7764a7b) |
| **Qoder CN** | Approvals, questions, thinking controls | CodexHost contributors: [gy212](https://github.com/gy212), [BytePioneer-AI (ChongWen)](https://github.com/BytePioneer-AI)<br>PR #289 merge: [8926130](https://github.com/BytePioneer-AI/codex-host/commit/8926130af1426a467747b66d8d2dbf68f7764a7b) |
| **Antigravity** | Session resume, tool calls, thinking controls | Permission settings select safety modes; no interactive approvals or questions.<br>CodexHost contributor: [gy212](https://github.com/gy212)<br>Initial integration: [ed4e785](https://github.com/BytePioneer-AI/codex-host/commit/ed4e785116642eafc08e4186e92e83f3816c7765) |

Each Agent handles its own installation and login. See the [Agent adapter documentation](specs/spec007.1-外部Agent适配器扩展/README.md) (Chinese) for integration details.

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
dsh plugin --profile web add @jingyi0605/codingns4dsh@0.2.1-beta.7
dsh web
```

### Optional: Use a Separate Profile

Create a separate environment from the built-in Web profile:

```bash
dsh codingns --from-default-profile web --dump-config
dsh plugin --profile codingns add @jingyi0605/codingns4dsh@0.2.1-beta.7
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

Thanks to **[CodexHost](https://github.com/BytePioneer-AI/codex-host)** and its community for the inspiration and implementation references for multi-Agent integration. Codingns4DSH is an independent project and is not affiliated with CodexHost.

Thanks to the adapter contributors and upstream contributors:

- [chenjunyi000](https://github.com/chenjunyi000): MiniMax Code, ZCode ([#6](https://github.com/jingyi0605/Codingns4DSH/pull/6), [#7](https://github.com/jingyi0605/Codingns4DSH/pull/7)).
- [mouzhi](https://github.com/mouzhi): CodeBuddy, Cursor CLI.
- [BytePioneer-AI (ChongWen)](https://github.com/BytePioneer-AI): WorkBuddy, Qoder.
- [gy212](https://github.com/gy212): Kiro CLI, Qoder, Antigravity.

---

## License

Released under the **GNU General Public License version 3 or later** (`GPL-3.0-or-later`). See [LICENSE](LICENSE) for the full terms.

Copyright (C) 2026 jingyi0605
