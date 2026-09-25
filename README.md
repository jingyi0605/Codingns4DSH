<div align="center">

# CodingNS for DeepSeek Harness

**Use your existing Agent CLIs, persistent terminals, workspace debugging, and remote access — inside DSH's own interface.**

[![npm version](https://img.shields.io/npm/v/dsh-codingns?logo=npm)](https://www.npmjs.com/package/dsh-codingns)
[![DSH compatibility](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.3%20%3C0.1.8-0-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-3C873A?logo=node.js&logoColor=white)](https://nodejs.org)

**Current release: `0.1.1`** · **DSH: `>=0.1.5-rc.3 <0.1.8-0`** (validated on `0.1.6-alpha.2`)

**Reach your own DSH Web UI from anywhere on the internet.** Beyond [LAN access](#lan-access-to-dsh), the [relay access service](#relay-access-service) carries the same DSH Web session to any device on any network — no public IP, no port forwarding, no VPN.

**End-to-end encrypted.** The relay moves WebRTC/DTLS ciphertext, so the relay service sees connection metadata only — never your DSH conversations, terminal output or files. See [End-to-end encryption](#end-to-end-encryption-why-the-relay-cannot-read-your-dsh-traffic).

**Repository: [jingyi0605/DSH-CodingNS](https://github.com/jingyi0605/DSH-CodingNS)** · **npm: [`dsh-codingns`](https://www.npmjs.com/package/dsh-codingns)** · **npm publisher: [`jingyi0605`](https://www.npmjs.com/~jingyi0605)**

**QQ discussion group: 1092985965**

<p>
  <a href="#what-is-codingns">What is CodingNS</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#feature-overview">Features</a> ·
  <a href="#supported-external-agents">Supported Agents</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#first-run">First run</a> ·
  <a href="#remote-access">Remote access</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="#development">Development</a> ·
  <a href="#community">Community</a> ·
  <a href="#acknowledgements">Acknowledgements</a> ·
  <a href="#中文说明">简体中文</a>
</p>

</div>

---

## Acknowledgements

CodingNS's inspiration — and part of its implementation approach — comes from **[CodexHost](https://github.com/BytePioneer-AI/codex-host)**.

CodexHost runs Pi, Claude Code, Grok Build and other Agent Harnesses natively inside Codex Desktop. It showed the direction CodingNS follows from the other side: a host application should host *other* Harnesses as first-class Agents instead of replacing them. The multi-Harness adapter model, projecting a CLI's event stream into the host's own native sessions, and keeping each Agent's sessions in the host's sidebar and composer all trace back to that project's design.

Thanks to the CodexHost authors and community. CodingNS is an independent project and is not affiliated with CodexHost.

---

## Table of contents

- [Acknowledgements](#acknowledgements)
- [What is CodingNS?](#what-is-codingns)
- [How it works](#how-it-works)
- [Feature overview](#feature-overview)
- [Features in detail](#features-in-detail)
  - [External Agent integration](#external-agent-integration)
  - [Workspace session enhancement](#workspace-session-enhancement)
  - [Terminal](#terminal)
  - [LAN access to DSH](#lan-access-to-dsh)
  - [Relay access service](#relay-access-service)
  - [Workspace debug](#workspace-debug)
- [Supported external Agents](#supported-external-agents)
- [Installation](#installation)
- [First run](#first-run)
- [Remote access](#remote-access)
- [Settings reference](#settings-reference)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Development](#development)
- [Community](#community)
- [中文说明](#中文说明)

---

## What is CodingNS?

**DeepSeek Harness (DSH)** is DeepSeek's coding-agent harness: a CLI plus a Web application that runs an agent loop inside your project workspace — sessions, tools, permissions, settings, and the browser UI.

DSH is designed to be extended. A **profile** is a named stack of plugin **bundles**, and a bundle may contribute both a **Host layer** (Node/Cordis plugins running in the DSH process) and a **browser layer** (UI modules injected into the DSH Web interface).

**CodingNS is such a bundle.** Installing it into a profile adds:

- **Your existing Agent CLIs as first-class Agents** — Claude Code, Codex, Kimi CLI, Gemini CLI, Pi Agent, OpenCode, Grok Build and Command Code appear in the DSH composer, and their streaming output, tool calls, permission prompts, questions, usage and thinking levels are rendered by DSH's native conversation UI.
- **A terminal that survives restarts** — sidebar terminals bound to a workspace or a session, restored after DSH restarts, with shell, theme, font, cursor and scrollback settings.
- **A workspace debug panel** — save launch profiles per workspace, start them in a terminal, watch configured ports, stop instances and open proxied services.
- **Remote access** — expose the local DSH Web UI to your LAN, or reach it through the CodingNS relay when the Host is not directly reachable.

Nothing in DSH is replaced: conversations, the session list, the sidebar, settings and permission prompts stay native. CodingNS registers modules and UI slots into them.

### Who is this for?

- You already run DSH and want to drive your existing Agent CLI subscriptions from one interface instead of switching between terminals.
- You keep several shells open per project and want them back after a DSH restart.
- You want to open the same DSH from a phone, tablet or another computer — on the same network, or through a relay.
- You want a per-workspace "start service → check port → open it" loop without leaving DSH.

### At a glance

| | |
| --- | --- |
| Package | `dsh-codingns` (DSH bundle: Host + browser layers) |
| Plugin version | `0.1.1` (independent from the DSH version) |
| DSH compatibility | `>=0.1.5-rc.3 <0.1.8-0`, validated on `0.1.6-alpha.2` |
| Node.js | `>= 22.19` |
| Platforms | macOS, Linux, Windows |
| Toolchain | `dsh` CLI; `pnpm` for plugin installation |
| Modules | 6 — see [Feature overview](#feature-overview) |
| External Agents | 8 adapters — see [Supported external Agents](#supported-external-agents) |
| Network behavior | Agent traffic goes to each Agent CLI's own provider. CodingNS contacts CodingNS servers only when you enable and log in to the relay service. |

---

## How it works

```
┌─ your machine (the "Host") ─────────────────────────────────────────┐
│  DSH process (Node.js, profile: codingns)                           │
│   ├─ @deepseek-ai/dsh-web-app   serves the browser UI               │
│   └─ dsh-codingns (this bundle)                                     │
│        ├─ Host layer   Agent adapters, terminal controller,         │
│        │               LAN listener, relay tunnel, debug service    │
│        └─ Browser layer Agent picker, sidebar terminal, settings    │
│                         cards, session logos, debug panel           │
│                                                                     │
│  Agent CLIs (claude / codex / kimi / gemini / …) run as child       │
│  processes of DSH and keep using their own credentials.             │
└─────────────────────────────────────────────────────────────────────┘
        ▲
        │  browser: http://127.0.0.1:<dsh-port>  (local)
        │           http://<lan-ip>:<listen-port> (LAN access module)
        │           relay tunnel                (relay module: from anywhere on
        │                                        the internet, no public IP)
```

Key consequences of this design:

- **The browser is only a view.** Every Agent process, terminal session and workspace file lives on the Host. Closing the browser does not stop them.
- **External Agents stay external.** CodingNS launches the CLI you already installed and authenticated, and projects its events into DSH sessions. Model requests go to that CLI's provider, not through CodingNS.
- **Remote paths are opt-in.** LAN access forwards TCP from a listener to the local DSH Web port and never leaves your network. The relay service is the path that reaches the same DSH Web from anywhere on the internet, it is used only after you enable the module and log in, and its traffic is end-to-end encrypted (WebRTC/DTLS) so the relay carries ciphertext rather than readable DSH content.

---

## Feature overview

All modules appear as cards under **Settings → CodingNS** (`设置 → CodingNS`). "Activation" tells you whether a change applies immediately or after restarting DSH.

| Module (settings card) | What you get | Where you use it | Runs on | Default | Activation |
| --- | --- | --- | --- | :---: | :---: |
| **External Agent integration**<br>`外部Agent集成` | Detect installed Agent CLIs, show version / command / available models, enable each Agent independently, and run them as native DSH streaming sessions | Composer Agent picker, **Settings → CodingNS** | Host + browser | **On** | live |
| **Workspace session enhancement**<br>`工作区会话增强` | Agent logo on each session row, archived-session entry per workspace, subscription/usage readout under the composer | DSH session sidebar | Browser | **Off**<br>(needs External Agent integration) | live |
| **Terminal enhancement**<br>`终端强化` | Persistent terminal backend plus terminal appearance (default shell, theme, colors, font, cursor, scrollback) | **Settings → CodingNS**, right sidebar Terminal | Browser + Host | **Off** | **restart** |
| **LAN access to DSH**<br>`局域网访问DSH` | A listener that forwards a LAN address to the current local DSH Web port; also installs the `crypto.randomUUID` shim that plain-HTTP LAN origins need | **Settings → CodingNS** | Browser + Host | **Always on** (no switch) | live |
| **Relay access service**<br>`中转访问服务` | Access your DSH Web **from anywhere on the internet**, not only from the LAN: CodingNS account login, DSH device list, Host binding and an isolated DSH–CodingNS relay tunnel — no public IP, no port forwarding, no VPN, and **end-to-end encrypted (WebRTC/DTLS)** | **Settings → CodingNS** | Browser + Host | **Off** | live |
| **Workspace debug**<br>`工作区调试` | Per-workspace launch profiles, start/stop, live port checks and an HTTP service proxy | Right sidebar **调试** tab | Browser + Host | **On** | live |

Notes:

- The right-sidebar terminal exists as soon as the plugin is installed. **Terminal enhancement** switches it from a basic local PTY to the persistent backend (tmux on macOS/Linux, ConPTY broker on Windows) and unlocks appearance settings.
- Restart-required modules save your intent, show the currently effective state, and apply on the next DSH start. Turning **Terminal enhancement** off does not terminate existing tmux/ConPTY sessions.
- The **Workspace debug** card is the one module that currently renders Chinese text only.

---

## Features in detail

### External Agent integration

CodingNS detects Agent CLIs on the **Host machine** by looking them up on `PATH`, then reads their version, command path and model catalog from the CLI itself. Each Agent can be enabled or disabled independently; detected Agents are enabled by default. The built-in **DeepSeek Harness** Agent always appears first in the picker.

When you select an Agent and a model in the composer, CodingNS starts (or resumes) that CLI as a child process of DSH and projects its event stream into a **native DSH session**:

- streaming assistant text, thinking levels and tool calls rendered by DSH's own components;
- permission prompts and Agent questions shown as native DSH interactions;
- subscription/usage information where the Agent exposes it;
- follow-up messages, interruption, and steering for Agents that support them;
- the last used model and thinking effort remembered per Agent.

Sessions started this way stay in the DSH sidebar like any other session, with the Agent's logo, and can be restored or archived from the session row (see [Workspace session enhancement](#workspace-session-enhancement)). The session index is stored on the Host and contains no credentials and no raw messages.

Installation and login for each Agent happen **outside** DSH, with that vendor's own tooling. CodingNS never stores Agent credentials.

### Workspace session enhancement

Three independent switches, all on by default once the module is enabled:

- **Agent logo** on each external session row, so you can tell which CLI produced a session.
- **Archived-session entry** in workspaces that have archived external sessions, so they can be brought back.
- **Subscription and usage readout** in the composer dock for Agents whose limits can be read (Command Code, Codex, Claude Code, OpenCode, Grok, and the built-in DSH Agent when an upstream usage source is configured). Third-party upstream usage is shown when configured, and official quota windows are hidden rather than shown incorrectly.

### Terminal

The plugin ships its own terminal stack: a DSH-speaking Host controller, the browser terminal UI, and xterm.js. The official DSH terminal rows are disabled in the same bundle generation so there is exactly one terminal service and one terminal UI.

- **Binding scope** — by workspace (default: DSH sessions in the same workspace share terminals) or by DSH session (each session gets its own).
- **Persistence** — in enhanced mode, terminals are backed by `tmux` on macOS/Linux and by a ConPTY broker on Windows, and are restored when DSH restarts. In the default basic mode terminals use a local PTY and do not survive a restart.
- **Shells** — "system recommended" is resolved on the Host from the operating system and installed shells; explicit choices are zsh, bash, PowerShell, cmd and Git Bash, limited to shells actually detected on the Host.
- **Appearance** — inherit the DSH theme or customize background, foreground, cursor color, font family, font size, line height, cursor shape, cursor blink and scrollback (1,000–100,000 lines).
- **Restart required** — enabling or disabling the module, and changing the binding scope, take effect after restarting DSH; the settings card reports both the effective state and the next-start intent.

### LAN access to DSH

Use this when the Host and your other device are on the same network.

1. Pick a **listen host** (all interfaces, or a specific interface) and a **listen port** (default `13080`).
2. Let CodingNS **auto-detect the local DSH Web port**, or type it manually.
3. Start the mapping, then open `http://<lan-ip>:<listen-port>` on the other device.

The module also installs a `crypto.randomUUID` shim in the browser, because plain-HTTP LAN origins are not secure contexts and some browsers do not expose that API there. **Auto-start** restores the mapping the next time DSH starts. This path stays on the local network and does not use the relay service.

### Relay access service

**The relay service goes beyond the LAN: it lets you open your own DSH Web UI from anywhere on the internet.** LAN access only works while the other device is on the same network as the Host; the relay carries the same DSH Web session across networks, NAT and mobile data — from another office, another city, or a phone on cellular. No public IP, no router port forwarding and no VPN are required.

Use this when direct access is not possible (different networks, NAT, no port forwarding) or simply when you are away from the local network:

1. Set the **Control API address** (default `https://channel.codingns.com:1443`; several addresses can be saved).
2. **Log in** with your CodingNS account.
3. **Refresh the device list** and select the DSH device.
4. **Bind the current Host** — the panel shows the Host label, public key and fingerprint.

The tunnel is an isolated DSH–CodingNS device channel: the Host's local DSH port is never exposed to the internet, and only a Host you have bound can be reached. The only networking requirements are outbound HTTPS from the Host to the Control API and connectivity from the device you browse with to the CodingNS relay entry. The password is used only for the login request; the refresh token and device credential are kept in the Host credential store, not in browser settings. Traffic inside the tunnel is **end-to-end encrypted with WebRTC/DTLS** — the relay handles connection metadata only, never DSH content. See [End-to-end encryption](#end-to-end-encryption-why-the-relay-cannot-read-your-dsh-traffic).

### Workspace debug

Per-workspace launch profiles, stored in `<workspace>/.codingns/debug.json`:

- **name**, **working directory** (relative to the workspace root), **command and arguments**, **environment variables** (secret-looking keys are rejected) and the **shell/runtime** to launch with;
- an optional **port** the command is expected to listen on;
- an optional **reverse proxy** toggle to expose that port through DSH.

From the right sidebar **调试** tab you can start a profile in a terminal, watch the port state (checked every few seconds), stop a running instance (only the process listening on the configured port is terminated — the terminal runtime is left alone), and open a proxied service through a per-instance, unguessable binding URL. The proxy is intentionally narrow: it serves only the port that the current running instance actually listens on, and it supports HTTP only — WebSocket proxying is not implemented yet.

---

## Supported external Agents

Each Agent is detected on the Host by command name; the version and model list are read from the CLI itself. Capability support depends on the Agent's protocol and version.

| Agent | Adapter id | CLI command(s) on `PATH` | Protocol | Capabilities |
| --- | --- | --- | --- | --- |
| Command Code | `command-code` | `command-code`, `commandcode`, `cmdc` | single-shot CLI (`--session` + `-p`) | models, streaming, resume, interrupt, tool events, reasoning, usage |
| Claude Code | `claude-code` | `claude` | stream-json | models, streaming, resume, interrupt, tool events, reasoning, usage |
| Kimi CLI | `kimi` | `kimi`, `kimi-cli` | stream-json | models, streaming, resume, interrupt, tool events, reasoning, usage, approvals, questions, steering |
| Gemini CLI | `gemini` | `gemini` | ACP | models, streaming, resume, interrupt, tool events, reasoning, usage, approvals |
| Pi Agent | `pi` | `pi`, `pi-agent` | JSON-RPC | models, streaming, resume, interrupt, tool events, reasoning, usage, steering |
| Codex | `codex` | `codex` | JSON-RPC (app-server) | models, streaming, resume, interrupt, tool events, reasoning, usage, approvals, questions, steering |
| OpenCode | `opencode` | `opencode` (or an existing server via `OPENCODE_SERVER_URL`, default `http://127.0.0.1:4096`) | HTTP + SSE | models, streaming, resume, interrupt, tool events, reasoning, usage, approvals, questions |
| Grok Build | `grok` | `grok`, `grok-build` | ACP | models, streaming, tool events, reasoning, usage, approvals |

Capability legend:

- **models** — the Agent's model list is read and offered in the composer.
- **streaming** — assistant text is streamed into the DSH session as it is produced.
- **resume** — an existing Agent session can be continued after a DSH restart.
- **interrupt** — the running turn can be cancelled.
- **tool events** — tool calls and results are rendered in the conversation.
- **reasoning** — thinking/effort level is exposed and selectable.
- **usage** — token or subscription usage is surfaced.
- **approvals / questions** — the Agent's permission prompts and questions become native DSH interactions.
- **steering** — a message can be injected while the Agent is working.

Anything not listed for an Agent is not supported by that CLI or its current version. The built-in **DeepSeek Harness** Agent is always available and needs no external CLI.

---

## Installation

### Requirements

| Requirement | Notes |
| --- | --- |
| **DSH `>=0.1.5-rc.3 <0.1.8-0`** | Tested with `0.1.6-alpha.2`. Plugin and DSH versions are released independently; keep them inside the declared range. |
| **Node.js `>= 22.19`** | Used by the `dsh` launcher and by the bundle. |
| **`pnpm` on `PATH`** | `dsh plugin` forwards to pnpm. DSH prints `dsh: pnpm was not found` if it is missing. |
| **A supported Agent CLI** | Only if you plan to use external Agents. Install and log in with the vendor's own installer. |
| **`tmux` (optional)** | Required only for persistent terminals (Terminal enhancement) on macOS/Linux. Windows uses the bundled ConPTY broker. |

Install tmux with `brew install tmux` (macOS), `sudo apt install tmux` (Debian/Ubuntu) or `sudo dnf install tmux` (Fedora/RHEL).

### Install from npm (recommended)

DSH installs plugins into a **profile**. CodingNS expects the profile to also contain the DSH Web application layer, so create a dedicated profile from the shipped `web` template first, then add the bundle:

```bash
# 1. Create a dedicated profile from the shipped web template.
#    --dump-config only creates the profile and prints the composed layer tree,
#    then exits; it does not start the server.
dsh codingns --from-default-profile web --dump-config

# 2. Install the CodingNS bundle into that profile.
dsh plugin --profile codingns add dsh-codingns@0.1.1

# 3. Start DSH with the profile.
dsh codingns
```

Or install into the standard `web` profile, if you prefer not to keep a separate profile:

```bash
dsh plugin --profile web add dsh-codingns@0.1.1
dsh web
```

What the install command does:

- it runs `pnpm add` inside `$DSH_HOME/profiles/<profile>` (default `~/.dsh/profiles/<profile>`);
- if the profile does not exist yet, DSH initializes it automatically;
- because `dsh-codingns` declares a bundle patch, the package is appended to `dsh.profile.bundles`, so the plugin's Host and browser layers are loaded on the next start;
- the CodingNS bundle patch disables the official DSH terminal rows and inserts the CodingNS terminal in the same bundle generation, so there is exactly one terminal service.

To install a later release, replace `0.1.1` with the version shown on the [npm package page](https://www.npmjs.com/package/dsh-codingns), keeping it inside the declared DSH compatibility range.

> **If the registry reports a 404 for `dsh-codingns`:** that version has not been published yet. Use [Install from source](#install-from-source-fallback) and add the local checkout instead — the rest of the setup is identical.

> **Do not** create a profile with the plugin as its very first command (`dsh plugin --profile dsh-codingns add …` on a fresh name). A brand-new custom profile only contains `@deepseek-ai/dsh-base`: it has no Web application layer, so the terminal patch cannot find its targets (you will see `patch: entry "terminal-controller" not found`) and there is no browser UI to open. Create the profile from the `web` template first, as shown above.

### Verify the installation

```bash
dsh --version                                  # DSH version, must be inside the supported range
dsh plugin --profile codingns list --depth 0   # dsh-codingns 0.1.1
dsh --profile codingns --dump-config           # composed plugin tree
```

In the composed tree, confirm both of these:

- an entry `id: dsh-codingns` (the bundle layer);
- `id: terminal-controller` marked `disabled: true` under the `dsh-codingns` patch layer, with no `patch: entry … not found` warnings on stderr.

### Upgrade, downgrade and uninstall

```bash
# upgrade or pin a different version
dsh plugin --profile codingns add dsh-codingns@<version>

# uninstall (the bundle entry is removed from the profile automatically)
dsh plugin --profile codingns remove dsh-codingns
```

After changing versions, restart DSH. Your configuration is preserved in the DSH settings document, so an upgrade does not reset module switches or Agent preferences.

### Install from source (fallback)

Use this when the npm package is not available to you yet, or when you want to run a checkout:

```bash
git clone https://github.com/jingyi0605/DSH-CodingNS.git
cd DSH-CodingNS
pnpm install
pnpm build

# create the profile first (see above), then install the checkout
dsh codingns --from-default-profile web --dump-config
dsh plugin --profile codingns add "$PWD"
dsh codingns
```

Installing a directory creates a linked dependency, so the profile keeps using the checkout's build output: run `pnpm build` again (or keep `pnpm dev:watch` running) and restart DSH after changing the source.

If you prefer an installable artifact, pack a tarball instead of linking the directory:

```bash
npm pack                                  # builds via prepack, then writes dsh-codingns-<version>.tgz
dsh plugin --profile codingns add ./dsh-codingns-0.1.1.tgz
```

### Where CodingNS keeps files

| Path | Contents |
| --- | --- |
| `$DSH_HOME/profiles/<profile>` (default `~/.dsh/profiles/<profile>`) | The DSH profile: installed plugin packages and `dsh.profile.bundles`. |
| `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`) | Plugin settings under the `codingns:` namespace: module switches, Agent enables, Agent preferences, LAN mapping, terminal appearance. |
| `$DSH_HOME/dsh-codingns/host-id` | Stable local terminal host identity (generated once per profile). |
| `$DSH_HOME/dsh-codingns/terminals.json` | Persistent terminal mapping used to restore terminals after a restart. |
| `~/.config/dsh-codingns/codingns-credentials.json` | Relay refresh token and device credential. Override the directory with `DSH_CODINGNS_STATE_DIR`. |
| `<workspace>/.codingns/debug.json` | Workspace debug launch profiles (mode `0600`, secrets rejected). |

---

## First run

1. **Start DSH**: `dsh codingns` opens the DSH Web UI in your browser.
2. **Open Settings → CodingNS** (`设置 → CodingNS`). You will see one card per module, with its current state and whether a restart is needed.
3. **External Agents**: install and log in to the Agent CLIs you want *outside* DSH, then confirm the commands are on the Host `PATH` (`which claude`, `which codex`, …). The card lists each Agent's detection status, version, command path and models; enable the ones you need.
4. **Start a session**: pick an Agent and a model in the composer, choose a thinking level if the Agent supports it, and send a prompt. Output streams into a native DSH session and appears in the sidebar with the Agent's logo.
5. **Terminals**: open the Terminal panel in the right sidebar and create a terminal for the current workspace. For persistence across restarts, enable **Terminal enhancement** in the settings card and restart DSH.
6. **Workspace debug**: open the right sidebar **调试** tab, add a launch profile for the workspace (command, working directory, optional port) and start it. CodingNS reports the port state and, when enabled, gives you a proxy URL for the service.
7. **Remote access (optional)**: for devices on your own network, set up [LAN access](#lan); to reach this same DSH Web **from anywhere on the internet**, log in to the [relay service](#relay).

---

## Remote access

CodingNS offers two independent remote paths. You can enable either or both — they solve different problems:

| | [LAN access to DSH](#lan) | [Relay access service](#relay) |
| --- | --- | --- |
| Connect from | Devices on the same local network | **Any device, anywhere — the internet is enough** |
| Typical use | Phone, tablet or second computer at home or in the office | Working away from the Host, across NAT, mobile data or a company network |
| Requirements | Host and device share a network, and the firewall allows the listen port | Outbound HTTPS from the Host to the CodingNS Control API, plus connectivity from your device to the CodingNS relay entry |
| Account needed | No | CodingNS account with a bound Host |
| Local port exposed | Yes — a listener on the chosen interface and port | No — traffic goes through the isolated device tunnel |
| Path to the Host | Direct TCP on your own network | DSH–CodingNS relay tunnel |

In short: **LAN access keeps you on the local network, while the relay access service lets you reach your own DSH Web service from anywhere on the internet.**

### LAN

Enable the mapping in the **LAN access to DSH** card:

1. choose a **listen host** — all interfaces (`0.0.0.0`) is the simplest choice, or pick a specific interface;
2. choose a **listen port** (default `13080`);
3. auto-detect or enter the **local DSH Web port**;
4. start, then open `http://<lan-ip>:<listen-port>` from the other device.

Notes: keep both devices on the same network, and allow the listen port through the Host firewall. If several DSH instances are running, auto-detect reports all candidate ports and asks you to choose one. Enable **auto-start** to restore the mapping whenever DSH starts.

### Relay

**This is the path for accessing your DSH from outside the local network** — over the internet, from any network the remote device happens to be on. The Host does not need a public IP, a port mapping or a VPN; it only needs outbound HTTPS access to the Control API.

Enable the **Relay access service** card:

1. enter the **Control API address** (default `https://channel.codingns.com:1443`; extra addresses can be saved and switched);
2. **log in** with your CodingNS account;
3. **refresh the device list** and select the target DSH device;
4. **bind the current Host**; the card shows the Host label, public key and fingerprint.

On the remote device, connect to the bound Host through the CodingNS entry and use DSH Web as usual — the same sessions, terminals and workspaces you have locally, since everything actually runs on the Host.

The relay carries the DSH Web connection through an isolated device tunnel, so the Host's local port is never exposed to the internet and only Hosts you have bound can be reached. Credentials stay on the Host.

### End-to-end encryption (why the relay cannot read your DSH traffic)

The relay path is end-to-end encrypted by design, so using it does not mean handing your conversations to a server. DSH traffic always travels inside a **WebRTC DataChannel protected by DTLS between the two endpoints** — the DSH Client in your remote browser and the DSH Host on your machine. The tunnel never hands business messages to the relay:

- **What the control service and relay handle**: account and device records, the Host binding, tickets, SDP/ICE signaling, online state and traffic accounting — control-plane metadata only.
- **What stays end-to-end encrypted**: DSH RPC and model messages, Agent output, terminal (PTY) input and output, tasks, file contents, ports and the remote DSH Web itself. Whether the two ends connect directly or through TURN, the payload stays encrypted end to end — the relay only ever forwards ciphertext.
- **The client verifies the Host's identity**: every Host generates and keeps its own DTLS certificate (`~/.config/dsh-codingns/dtls-identity.json`) and publishes its SHA-256 fingerprint. The remote side checks the fingerprint during the WebRTC handshake and aborts the connection on a mismatch (`Host DTLS fingerprint 校验失败`) instead of silently accepting a substituted certificate. The same fingerprint is shown in the relay settings card so you can compare it manually.
- **Credentials stay on the Host**: your account password is used only for the login request; the refresh token and the device credential live in the Host credential store, not in the browser.
- **Diagnostics never log content**: tunnel diagnostics record protocol metadata (direction, message type, stream id, status, byte count) and never envelope bodies, tickets, cookies or DSH Web content.

These are design gates of the tunnel rather than incidental behavior: the control service and relay may only process control-plane metadata, gateway business messages must never be handed to the relay, and all DSH payloads must be end-to-end encrypted between the DSH Client and the DSH Host.

### Security notes

- LAN access is a plain TCP forward on your own network — use it on trusted networks only.
- Relay traffic is end-to-end encrypted (WebRTC/DTLS): the relay and control service see connection metadata, not your DSH conversations, terminal output or files.
- The relay tunnel only operates after you log in and bind the Host; log out to drop the session.
- Agent credentials never pass through CodingNS; each CLI keeps using its own configuration.
- Tunnel diagnostics never log envelope bodies, tickets, cookies or DSH Web content.

---

## Settings reference

Settings live in the DSH settings document (`$DSH_HOME/settings.yaml`, default `~/.dsh/settings.yaml`) under the `codingns` namespace. The settings page is the supported way to change them.

| Setting | Meaning | Default |
| --- | --- | --- |
| `modules.<moduleName>` | Per-module enable intent (`cliAdapters`, `workspaceSessionEnhancement`, `terminalEnhancement`, `reverseProxy`, `debug`). | Each module's own default |
| `agentAdapters.<adapterId>` | Per-Agent enable intent. | All detected Agents enabled |
| `agentAdapterPreferences.<adapterId>` | Last used model and thinking effort per Agent. | remembered per Agent |
| `cliSessions` | Host-side index of external sessions (no credentials, no messages). | — |
| `lanAccessDsh.autoStart` | Restore the LAN mapping when DSH starts. | `false` |
| `lanAccessDsh.listenHost` / `listenPort` | Listener interface and port. | `0.0.0.0` / `13080` |
| `lanAccessDsh.dshPort` | Local DSH Web port; `0` means auto-detect. | `0` |
| `terminalEnhancement.bindingScope` | `workspace` (share terminals per workspace) or `session`. | `workspace` |
| `terminalEnhancement.defaultProfile` | Default shell for new terminals (`system`, `zsh`, `bash`, `powershell`, `cmd`, `git-bash`). | `system` |
| `terminalEnhancement.appearance.*` | Theme, colors, font, cursor and scrollback; `null` inherits DSH. | inherit |
| `workspaceSessionEnhancement.showAdapterLogo` / `showArchivedSessions` / `showSubscriptionUsage` | Session-row enhancements. | `true` |
| `controlBaseUrl` / `controlBaseUrls` | Relay Control API addresses. | `https://channel.codingns.com:1443` |

---

## Troubleshooting

### Check versions first

```bash
dsh --version
dsh plugin --profile codingns list --depth 0
npm view dsh-codingns version
```

Keep DSH inside `>=0.1.5-rc.3 <0.1.8-0`. The bundle's launch glue validates the running DSH version and refuses to take over the connection for an unsupported Host; upgrade or downgrade DSH instead of mixing versions.

### `patch: entry "terminal-controller" not found`

The profile has no DSH Web application layer, which happens when a custom profile is created by the plugin install itself. Recreate the profile from the `web` template and install again:

```bash
dsh codingns --from-default-profile web --dump-config
dsh plugin --profile codingns add dsh-codingns@0.1.1
```

### An Agent is not detected

- Confirm the CLI works in a terminal **on the Host machine**: `claude --version`, `codex --version`, `kimi --version`, …
- Confirm its directory is on the `PATH` **of the process that started DSH** (GUI launchers often have a shorter `PATH` than your shell).
- Log in to the Agent with its own tooling; CodingNS only launches it.
- Restart DSH after changing `PATH` or installing a CLI, then re-open the settings card.

### Terminal problems

- Persistent terminals require `tmux` on macOS/Linux. If it is missing, the settings card reports the runtime as unavailable; install tmux and restart DSH.
- Enabling/disabling **Terminal enhancement** and changing the binding scope take effect only after a DSH restart; the card shows the effective state versus the next-start intent.
- Terminals are addressed by workspace; if a terminal seems to belong to another session, check the binding scope.

### LAN access does not connect

- Verify the listener is running: the card shows `Forwarding: <host>:<port> → DSH Web 127.0.0.1:<dshPort>`.
- Allow the listen port through the Host firewall, and make sure both devices are on the same network and can reach the Host's IP.
- If auto-detect finds no port, start the DSH Web UI first or enter the DSH port manually.

### Relay login or binding fails

- Check the Control API address and that the Host can reach it over HTTPS.
- Log in again if the session expired; then refresh the device list.
- Bind the Host before expecting the tunnel to accept connections; the card shows the bound Host label and fingerprint.

### Diagnostics and logs

Tunnel diagnostics are disabled by default. Start DSH with:

```bash
DSH_CODINGNS_TUNNEL_DEBUG=1 dsh codingns --no-open
```

Diagnostic records include connection direction, message type, stream id, operation, scope, status and byte count. Envelope bodies, tickets, cookies and DSH Web content are never logged. Plugin install diagnostics (pnpm output) are written to `$DSH_HOME/profiles/<profile>/.plugin-manager/logs/`.

### Reporting a problem

Include the DSH version, CodingNS version, operating system, the module you were using, what you expected, what happened, and the exact error text. Report through [GitHub Issues](https://github.com/jingyi0605/DSH-CodingNS/issues) or the QQ group **1092985965**.

---

## Roadmap

Planned for upcoming releases — design targets, not promises for the current version:

- **PeerHost** — direct Host-to-Host resource discovery and collaboration.
- **Enhanced file management** — browse, search, upload, download and common file operations inside a workspace.
- **Enhanced workspace sessions** — deeper organization, filtering, metadata and cross-device synchronization.
- **Debug service proxy, completed** — authenticated bindings and WebSocket support on top of today's HTTP-only proxy.
- **Git management** — repository status, branches, commits, diffs and common Git operations.
- **SKILL management** — discover, install, enable, disable and update reusable Agent skills.
- **More** — additional workspace automation and collaboration modules driven by community feedback.

---

## Development

Requirements: Node.js `>= 22.19` and pnpm.

```bash
pnpm install
pnpm build       # version check → tsc → client bundle → H5 bundle
pnpm test        # build, then node --test tests/*.spec.ts
pnpm typecheck   # tsc --noEmit
```

Useful scripts:

| Script | Purpose |
| --- | --- |
| `pnpm build` | Clean `data/build/`, emit TypeScript, bundle the browser client and the H5 entry. |
| `pnpm test` | Full build plus the test suites in `tests/`. |
| `pnpm dev:link <profile>` | Symlink this checkout into `$DSH_HOME/profiles/<profile>/node_modules`. |
| `pnpm dev:watch` | Rebuild in watch mode; restart DSH after a rebuild. |
| `pnpm run version:check` | Verify that `version.json`, the sources and the manifests agree. |
| `pnpm run version:set-plugin -- <version>` | Update the plugin version across the version sources. |
| `pnpm run version:set-dsh -- <version> [range]` | Update the tested DSH version and compatibility range. |

Repository layout:

| Path | Contents |
| --- | --- |
| `src/host/` | Host layer: Agent adapters, terminal controller, LAN listener, auth, relay/device runtime, debug service, RPC table. |
| `src/client/` | Browser layer: Settings cards, terminal UI, composer slots, session-row enhancements, debug panel, locale, theme. |
| `src/shared/contracts/` | Version, settings, feature, Agent, terminal and debug contracts shared by both layers. |
| `src/features/` | Feature registry: dependency ordering, state transitions and resource disposal. |
| `src/transport/` | DSH transport/tunnel: envelopes, framing, multiplexer, WebRTC carrier, diagnostics. |
| `tests/` | 58 suites covering contracts, modules, terminal backends, transport and client behaviour. |
| `specs/`, `docs/` | Design records and module/UI development rules. |
| `profile/` | Reference profile used by the CodingNS shell; it selects only the CodingNS bundle. |
| `data/build/` | Build output (git-ignored; produced by `pnpm build`). |

Publishing: pushing a `v*` tag runs the GitHub Actions workflow, which validates the tag against `version.json`, installs with a frozen lockfile, runs the type check and tests, verifies the package contents and publishes to npm with provenance (prerelease versions use the `next` dist-tag).

---

## Community

- QQ discussion group: **1092985965**
- Repository: [github.com/jingyi0605/DSH-CodingNS](https://github.com/jingyi0605/DSH-CodingNS)
- npm package: [`dsh-codingns`](https://www.npmjs.com/package/dsh-codingns)
- Issues and feature requests: [GitHub Issues](https://github.com/jingyi0605/DSH-CodingNS/issues)

When reporting a problem, please include the DSH version, CodingNS version, operating system, the module you were using and the relevant error message.

---

## 中文说明

[返回 English](#codingns-for-deepseek-harness)

### 鸣谢

CodingNS 的项目灵感以及部分实现思路来自 **[CodexHost](https://github.com/BytePioneer-AI/codex-host)**。

CodexHost 把 Pi、Claude Code、Grok Build 等 Agent Harness 原生地运行在 Codex Desktop 中。它展示了 CodingNS 从另一侧沿用的方向：宿主应用应当把**其他 Harness 作为一等 Agent 接入**，而不是替换它们。CodingNS 的多 Harness 适配器模型、把 CLI 事件流投影为宿主原生会话，以及让每个 Agent 的会话留在宿主侧栏与输入框中，都源自该项目的设计思路。

感谢 CodexHost 的作者与社区。CodingNS 是独立项目，与 CodexHost 没有从属关系。

> **不只是局域网：中转访问服务让你在互联网上的任何位置访问自己的 DSH Web 服务** —— 不需要公网 IP、路由器端口映射或 VPN；并且中转链路**端到端加密**，Relay 只能看到连接元数据，看不到你的 DSH 对话、终端输出或文件内容。详见 [远程访问](#远程访问)。

### 项目简介

**DeepSeek Harness（DSH）** 是 DeepSeek 的编码 Agent 运行框架，由 CLI 和 Web 应用组成，在你的项目工作区里运行 Agent 循环，提供会话、工具、权限、设置和浏览器界面。

DSH 支持扩展：一个 **Profile** 就是若干插件 **Bundle** 组成的分层栈，而 Bundle 可以同时提供 **Host 层**（运行在 DSH 进程里的 Node/Cordis 插件）和 **浏览器层**（注入 DSH Web 界面的 UI 模块）。

**CodingNS 就是这样一个 Bundle。** 把它装进 Profile 后，你会得到：

- **把已有的 Agent CLI 变成 DSH 里的一等 Agent**：Claude Code、Codex、Kimi CLI、Gemini CLI、Pi Agent、OpenCode、Grok Build、Command Code 都会出现在 DSH 输入框的 Agent 选择器里，流式输出、工具调用、权限确认、提问、用量和思考强度都由 DSH 原生对话界面渲染。
- **重启也不会丢的终端**：侧栏终端按工作区或按会话绑定，DSH 重启后自动恢复，并支持 Shell、主题、字体、光标和滚动缓冲区设置。
- **工作区调试面板**：为每个工作区保存启动配置，在终端中启动命令、检查端口、停止实例、打开代理后的服务。
- **远程访问**：把本机 DSH Web 暴露到局域网；**更不止于此——中转访问服务让你在互联网上的任何位置访问自己的 DSH Web**，无需公网 IP、端口映射或 VPN。

DSH 的任何部分都不会被替换：对话、会话列表、侧栏、设置和权限确认仍然是原生组件，CodingNS 只是向它们注册模块和 UI 插槽。

**适合谁用**

- 已经在用 DSH，希望在一个界面里驱动已有的 Agent CLI 订阅，而不是在多个终端之间切换；
- 每个项目都开着好几个终端，希望 DSH 重启后终端还在；
- 想用手机、平板或另一台电脑打开同一个 DSH（同一局域网，或通过中转）；
- 想在 DSH 内完成「启动服务 → 检查端口 → 打开服务」的工作区闭环。

### 工作原理

```
┌─ 你的机器（Host 主机） ─────────────────────────────────────────────┐
│  DSH 进程（Node.js，Profile：codingns）                             │
│   ├─ @deepseek-ai/dsh-web-app   提供浏览器界面                      │
│   └─ dsh-codingns（本 Bundle）                                      │
│        ├─ Host 层    外部 Agent 适配器、终端控制器、                 │
│        │             局域网监听、中继隧道、调试服务                  │
│        └─ 浏览器层   Agent 选择器、侧栏终端、设置卡片、              │
│                      会话 Logo、调试面板                            │
│                                                                     │
│  Agent CLI（claude / codex / kimi / gemini …）作为 DSH 子进程运行，  │
│  继续使用它们自己的凭据和上游服务。                                 │
└─────────────────────────────────────────────────────────────────────┘
        ▲
        │  浏览器：http://127.0.0.1:<DSH 端口>（本机）
        │          http://<局域网 IP>:<监听端口>（局域网访问模块）
        │          中继隧道（中转访问模块：在互联网任何位置访问，
        │                    无需公网 IP）
```

由此带来的几个结论：

- **浏览器只是视图**：Agent 进程、终端会话和工作区文件都在 Host 上，关掉浏览器不会中断它们。
- **外部 Agent 仍然是「外部」的**：CodingNS 启动你已经安装并登录好的 CLI，把事件投影进 DSH 会话；模型请求发往该 CLI 自己的上游，不经过 CodingNS。
- **远程访问是可选项**：局域网访问只是把 TCP 转发到本机 DSH Web 端口，不会离开你的网络；中转访问服务让你在互联网上的任何位置打开同一个 DSH Web，同样只在你启用模块并登录后才会建立连接，而且链路端到端加密（WebRTC/DTLS），Relay 承载的是密文而不是可读的 DSH 内容。

### 功能总览

所有模块都会出现在 **设置 → CodingNS** 中。「生效方式」说明改动是立即生效还是需要重启 DSH。

| 模块（设置卡片） | 提供的能力 | 使用位置 | 运行端 | 默认 | 生效方式 |
| --- | --- | --- | --- | :---: | :---: |
| **外部 Agent 集成** | 检测已安装的 Agent CLI，显示版本、命令路径和可用模型，可单独启停，并以 DSH 原生流式会话运行 | 输入框 Agent 选择器、**设置 → CodingNS** | Host + 浏览器 | **开** | 实时 |
| **工作区会话增强** | 会话行显示 Agent Logo、归档会话入口、输入框下方的订阅/用量信息 | DSH 会话列表 | 浏览器 | **关**<br>（依赖外部 Agent 集成） | 实时 |
| **终端强化** | 持久终端后端，以及终端外观（默认 Shell、主题、颜色、字体、光标、滚动缓冲区） | **设置 → CodingNS**、右侧栏终端 | 浏览器 + Host | **关** | **需重启** |
| **局域网访问 DSH** | 监听端口并把局域网地址转发到当前本机 DSH Web；同时补齐明文 HTTP 来源所需的 `crypto.randomUUID` | **设置 → CodingNS** | 浏览器 + Host | **常驻**（无开关） | 实时 |
| **中转访问服务** | **在互联网上的任何位置访问自己的 DSH Web**，而不只是在局域网内：登录 CodingNS、管理 DSH 设备、绑定 Host，并建立独立的 DSH–CodingNS 中继隧道——无需公网 IP、端口映射或 VPN，且**端到端加密（WebRTC/DTLS）** | **设置 → CodingNS** | 浏览器 + Host | **关** | 实时 |
| **工作区调试** | 按工作区保存启动配置、启动/停止、端口检查、HTTP 服务代理 | 右侧栏 **调试** 面板 | 浏览器 + Host | **开** | 实时 |

补充说明：

- 插件安装后右侧栏终端就已经存在；**终端强化** 只是把它从基础本地 PTY 切换为持久后端（macOS/Linux 使用 tmux，Windows 使用 ConPTY broker），并解锁外观设置。
- 需要重启的模块会先保存你的选择，界面上同时显示「当前生效状态」和「下次启动目标」。关闭 **终端强化** 不会结束已经存在的 tmux/ConPTY 会话。
- **工作区调试** 是目前唯一界面文案只有中文的模块。

### 功能详解

#### 外部 Agent 集成

CodingNS 在 **Host 机器** 上通过 `PATH` 查找 Agent CLI，再从 CLI 自身读取版本、命令路径和模型列表。每个 Agent 都可以单独启停，检测到的 Agent 默认启用；内置的 **DeepSeek Harness** Agent 始终排在选择器第一位。

在输入框选择 Agent 和模型后，CodingNS 会以 DSH 子进程方式启动（或恢复）该 CLI，并把事件流投影成 **DSH 原生会话**：

- 流式回复、思考强度和工具调用使用 DSH 自身组件渲染；
- 权限确认和 Agent 提问变成 DSH 原生交互；
- Agent 支持时显示订阅/用量信息；
- 支持追问、打断，以及支持的 Agent 的插话（steering）；
- 按 Agent 记住上次使用的模型和思考强度。

这样创建的会话和普通会话一样留在 DSH 侧栏中，并带有所用 Agent 的 Logo，可以从会话行恢复或归档（见下文「工作区会话增强」）。会话索引保存在 Host 上，不包含凭据和原始消息。

Agent 的安装和登录都在 DSH **之外** 用各家自己的工具完成，CodingNS 不保存 Agent 凭据。

#### 工作区会话增强

启用模块后有三个互相独立的开关，默认全部开启：

- **Agent Logo**：在外部会话行显示所用 CLI 的图标，便于区分会话来源。
- **归档会话入口**：在存在已归档外部会话的工作区中提供恢复入口。
- **订阅与用量**：在输入框底部显示可读取额度的 Agent（Command Code、Codex、Claude Code、OpenCode、Grok，以及配置了上游用量来源时的内置 DSH Agent）的用量；配置了第三方上游时显示上游用量，而不是错误地显示官方额度。

#### 终端

插件自带完整的终端链路：DSH 协议的 Host 控制器、浏览器终端 UI 和 xterm.js。同一个 Bundle generation 会成对停用官方终端相关行，保证系统中只有一个终端服务和一套终端界面。

- **绑定范围**：按工作区（默认，同一工作区内的多个 DSH 会话共享终端）或按 DSH 会话（每个会话独立终端）。
- **持久化**：强化模式下，macOS/Linux 由 `tmux` 承载、Windows 由 ConPTY broker 承载，DSH 重启后会自动恢复；默认的基础模式使用本地 PTY，重启后不保留。
- **Shell**：「系统推荐」由 Host 根据操作系统和已安装 Shell 解析；也可以显式选择 zsh、bash、PowerShell、cmd、Git Bash，且只允许 Host 上实际检测到的 Shell。
- **外观**：继承 DSH 主题，或自定义背景色、前景色、光标颜色、字体、字号、行高、光标形状、光标闪烁和滚动缓冲区（1,000–100,000 行）。
- **需要重启**：启用/停用模块以及修改绑定范围，都在重启 DSH 后生效，设置卡片会显示当前生效状态与下次启动目标。

#### 局域网访问 DSH

当 Host 和其他设备在同一网络时使用：

1. 选择 **监听网卡**（全部网卡或指定网卡）和 **监听端口**（默认 `13080`）；
2. 让 CodingNS **自动探测本机 DSH Web 端口**，或手动填写；
3. 启动映射，然后在另一台设备打开 `http://<局域网 IP>:<监听端口>`。

模块还会在浏览器里补齐 `crypto.randomUUID`：明文 HTTP 的局域网来源不是安全上下文，部分浏览器不提供该 API。开启 **自动启动** 后，下次 DSH 启动会恢复该映射。这条链路只在你自己的局域网内，不经过中转服务。

如需保护 DSH Web，在 **登录保护** 模块中设置用户名、至少 8 位密码、会话超时时间，并选择局域网或中继访问范围。本机 `127.0.0.1` / `::1` 永远放行，避免本地配置错误导致无法进入 DSH。认证发生在 Host 的转发边界：未登录请求不会被转发到 DSH Web，上游 DSH 启动时生成的一次性认证 Cookie 也只由 Host 自动接管，不会暴露给浏览器。密码使用 `scrypt` 哈希并以当前用户可读写的 `0600` 文件保存；浏览器仅持有 `HttpOnly`、`SameSite=Strict` 会话 Cookie。

#### 中转访问服务

**中转服务突破局域网限制：让你在互联网上的任何位置打开自己的 DSH Web 界面。** 局域网访问只在其他设备与 Host 处于同一网络时可用；中转则把同一个 DSH Web 会话跨网络、跨 NAT、跨移动数据送达——在另一个办公室、另一座城市，或用手机蜂窝网络都没问题，不需要公网 IP、路由器端口映射或 VPN。

当无法直连时（跨网络、NAT、没有端口映射），或只是不在本机网络附近时使用：

1. 配置 **Control API 地址**（默认 `https://channel.codingns.com:1443`，可保存多个地址切换）；
2. 使用 CodingNS 账号 **登录**；
3. **刷新设备列表** 并选择目标 DSH 设备；
4. **绑定当前 Host**，面板会显示 Host 标签、公钥和指纹。

隧道是独立的 DSH–CodingNS 设备通道：Host 的本地 DSH 端口不会暴露到互联网，只有你绑定过的 Host 才能被访问。网络要求只有两点——Host 能出站访问 Control API（HTTPS），以及你使用的设备能连上 CodingNS 的中转入口。密码只用于登录请求，refresh token 和设备凭据保存在 Host 凭据存储中，不写入浏览器设置。隧道内的 DSH 流量**端到端加密（WebRTC/DTLS）**，Relay 只处理连接元数据，看不到 DSH 内容，详见 [端到端加密](#端到端加密中转服务看不到你的-dsh-内容)。

#### 工作区调试

每个工作区一份启动配置，保存在 `<工作区>/.codingns/debug.json`：

- **名称**、**工作目录**（工作区内相对路径）、**命令与参数**、**环境变量**（形似密钥的键会被拒绝）以及启动所用的 **Shell/运行时**；
- 可选的 **端口**（命令预期监听的端口）；
- 可选的 **反向代理** 开关，把该端口通过 DSH 暴露出来。

在右侧栏 **调试** 面板中，你可以启动配置对应的命令（在终端里运行）、查看端口状态（每隔几秒检查一次）、停止运行中的实例（只结束监听配置端口的那个进程，不影响终端运行时），并通过每个实例独立、不可猜测的绑定地址打开代理后的服务。代理范围是刻意收窄的：只代理当前运行实例实际监听的端口，并且目前仅支持 HTTP，WebSocket 代理尚未实现。

### 支持的外部 Agent

每个 Agent 都按命令名在 Host 上检测，版本和模型列表从 CLI 自身读取。能力支持情况取决于该 Agent 的协议和版本。

| Agent | 适配器 id | `PATH` 中的命令 | 协议 | 能力 |
| --- | --- | --- | --- | --- |
| Command Code | `command-code` | `command-code`、`commandcode`、`cmdc` | 单轮 CLI（`--session` + `-p`） | 模型、流式、恢复、打断、工具事件、思考强度、用量 |
| Claude Code | `claude-code` | `claude` | stream-json | 模型、流式、恢复、打断、工具事件、思考强度、用量 |
| Kimi CLI | `kimi` | `kimi`、`kimi-cli` | stream-json | 模型、流式、恢复、打断、工具事件、思考强度、用量、权限确认、提问、插话 |
| Gemini CLI | `gemini` | `gemini` | ACP | 模型、流式、恢复、打断、工具事件、思考强度、用量、权限确认 |
| Pi Agent | `pi` | `pi`、`pi-agent` | JSON-RPC | 模型、流式、恢复、打断、工具事件、思考强度、用量、插话 |
| Codex | `codex` | `codex` | JSON-RPC（app-server） | 模型、流式、恢复、打断、工具事件、思考强度、用量、权限确认、提问、插话 |
| OpenCode | `opencode` | `opencode`（或通过 `OPENCODE_SERVER_URL` 复用已有服务，默认 `http://127.0.0.1:4096`） | HTTP + SSE | 模型、流式、恢复、打断、工具事件、思考强度、用量、权限确认、提问 |
| Grok Build | `grok` | `grok`、`grok-build` | ACP | 模型、流式、工具事件、思考强度、用量、权限确认 |

能力含义：

- **模型**：读取并展示该 Agent 的模型列表；
- **流式**：回复边生成边流入 DSH 会话；
- **恢复**：DSH 重启后可以继续已有的 Agent 会话；
- **打断**：可以取消正在进行的回合；
- **工具事件**：工具调用与结果在对话中渲染；
- **思考强度**：暴露并可选择思考/推理强度；
- **用量**：显示 token 或订阅用量；
- **权限确认 / 提问**：Agent 的权限请求和提问变成 DSH 原生交互；
- **插话**：Agent 工作过程中可以追加消息。

未列出的能力表示该 CLI 或其当前版本不支持。内置的 **DeepSeek Harness** Agent 始终可用，不需要任何外部 CLI。

### 安装

#### 环境要求

| 要求 | 说明 |
| --- | --- |
| **DSH `>=0.1.5-rc.3 <0.1.8-0`** | 已在 `0.1.6-alpha.2` 上验证。插件与 DSH 版本独立发布，请保持在该范围内。 |
| **Node.js `>= 22.19`** | `dsh` 启动器和本 Bundle 都依赖该版本。 |
| **`PATH` 中有 `pnpm`** | `dsh plugin` 会转发给 pnpm；缺失时 DSH 会提示 `dsh: pnpm was not found`。 |
| **受支持的 Agent CLI** | 仅在使用外部 Agent 时需要，请用各家官方方式安装并登录。 |
| **`tmux`（可选）** | 只有 macOS/Linux 上的持久终端（终端强化）需要；Windows 使用内置 ConPTY broker。 |

安装 tmux：macOS `brew install tmux`，Debian/Ubuntu `sudo apt install tmux`，Fedora/RHEL `sudo dnf install tmux`。

#### 从 npm 安装（推荐）

DSH 把插件安装到 **Profile** 中。CodingNS 需要 Profile 同时包含 DSH Web 应用层，因此先用官方 `web` 模板创建独立 Profile，再安装插件：

```bash
# 1. 用官方 web 模板创建独立 Profile。
#    --dump-config 只创建 Profile 并打印合成后的层结构，不会启动服务。
dsh codingns --from-default-profile web --dump-config

# 2. 把 CodingNS 安装进该 Profile。
dsh plugin --profile codingns add dsh-codingns@0.1.1

# 3. 使用该 Profile 启动 DSH。
dsh codingns
```

如果你不想单独维护一个 Profile，也可以直接装进标准的 `web` Profile：

```bash
dsh plugin --profile web add dsh-codingns@0.1.1
dsh web
```

安装命令做了什么：

- 在 `$DSH_HOME/profiles/<profile>`（默认 `~/.dsh/profiles/<profile>`）中执行 `pnpm add`；
- 安装前会执行 DSH 版本门禁：读取当前 `dsh --version`，不在插件 `engines.dsh` 范围内时直接终止安装；
- Profile 不存在时由 DSH 自动初始化；
- 由于 `dsh-codingns` 声明了 Bundle patch，包名会被自动追加到 `dsh.profile.bundles`，下次启动即加载插件的 Host 层和浏览器层；
- CodingNS 的 Bundle patch 会在同一个 Bundle generation 中停用官方终端相关行并插入 CodingNS 终端，保证只有一个终端服务。

安装后续版本时，把 `0.1.1` 替换为 [npm 包页面](https://www.npmjs.com/package/dsh-codingns) 上的目标版本，并保持在上表声明的 DSH 兼容范围内。

> **如果 npm 返回 `dsh-codingns` 404**：说明该版本还没有发布到 registry。请改用 [从源码安装](#从源码安装备选)，把本地检出目录装进 Profile，其余步骤完全相同。

> **不要**把 `dsh plugin --profile dsh-codingns add …` 当作新 Profile 的第一条命令：全新的自定义 Profile 只包含 `@deepseek-ai/dsh-base`，没有 Web 应用层，终端 patch 找不到目标（会出现 `patch: entry "terminal-controller" not found`），也没有可打开的浏览器界面。请按上面的步骤先用 `web` 模板创建 Profile。

#### 验证安装

```bash
dsh --version                                  # DSH 版本，必须在支持范围内
dsh plugin --profile codingns list --depth 0   # 应显示 dsh-codingns 0.1.1
dsh --profile codingns --dump-config           # 打印合成后的插件树
```

在合成结果中确认两点：

- 存在 `id: dsh-codingns` 条目（Bundle 层）；
- 在 `dsh-codingns` patch 层下 `id: terminal-controller` 标记为 `disabled: true`，并且 stderr 中没有 `patch: entry … not found` 警告。

#### 升级、降级与卸载

```bash
# 升级或固定到指定版本
dsh plugin --profile codingns add dsh-codingns@<版本>

# 卸载（Bundle 条目会自动从 Profile 中移除）
dsh plugin --profile codingns remove dsh-codingns
```

更换版本后请重启 DSH。设置保存在 DSH 设置文档中，升级不会重置模块开关和个人偏好。

#### 从源码安装（备选）

当 npm 包暂时不可用，或你希望直接运行本地检出时使用：

```bash
git clone https://github.com/jingyi0605/DSH-CodingNS.git
cd DSH-CodingNS
pnpm install
pnpm build

# 先创建 Profile（见上文），再安装本地检出
dsh codingns --from-default-profile web --dump-config
dsh plugin --profile codingns add "$PWD"
dsh codingns
```

安装目录会创建链接依赖，Profile 直接使用检出目录的构建产物：修改源码后重新执行 `pnpm build`（或保持 `pnpm dev:watch` 运行）并重启 DSH 即可。

如果希望使用可分发产物，也可以先打包再安装：

```bash
npm pack                                  # 通过 prepack 自动构建，生成 dsh-codingns-<版本>.tgz
dsh plugin --profile codingns add ./dsh-codingns-0.1.1.tgz
```

#### 文件位置

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/profiles/<profile>`（默认 `~/.dsh/profiles/<profile>`） | DSH Profile：已安装的插件包与 `dsh.profile.bundles`。 |
| `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`） | `codingns:` 命名空间下的插件设置：模块开关、Agent 启停、Agent 偏好、局域网映射、终端外观。 |
| `$DSH_HOME/dsh-codingns/host-id` | 本机终端宿主标识（每个 Profile 生成一次）。 |
| `$DSH_HOME/dsh-codingns/terminals.json` | 用于重启后恢复终端的持久映射。 |
| `~/.config/dsh-codingns/codingns-credentials.json` | 中转 refresh token 与设备凭据；可用 `DSH_CODINGNS_STATE_DIR` 修改目录。 |
| `<工作区>/.codingns/debug.json` | 工作区调试启动配置（权限 `0600`，拒绝保存密钥）。 |

### 首次使用

1. **启动 DSH**：`dsh codingns` 会在浏览器中打开 DSH Web 界面。
2. **打开 设置 → CodingNS**：每个模块一张卡片，显示当前状态以及是否需要重启。
3. **外部 Agent**：在 DSH **之外** 安装并登录需要的 Agent CLI，确认命令在 Host 的 `PATH` 中（`which claude`、`which codex` 等）。卡片会列出每个 Agent 的检测状态、版本、命令路径和模型，按需启用。
4. **开始会话**：在输入框选择 Agent 和模型（支持时再选思考强度），发送消息。输出会流式写入 DSH 原生会话，并带着 Agent Logo 出现在侧栏。
5. **终端**：在右侧栏终端面板为当前工作区新建终端。若希望重启后仍然保留，请在设置卡片启用 **终端强化** 并重启 DSH。
6. **工作区调试**：打开右侧栏 **调试** 面板，为工作区新增启动配置（命令、工作目录、可选端口）并启动；CodingNS 会报告端口状态，启用代理后还会给出服务访问地址。
7. **远程访问（可选）**：同一网络内的设备使用 [局域网访问](#局域网)；若想**在互联网上的任何位置**打开同一个 DSH Web，请登录 [中转服务](#中转)。

### 远程访问

CodingNS 提供两条互相独立的远程通道，可以只启用其一，也可以同时启用：

| | [局域网访问 DSH](#局域网) | [中转访问服务](#中转) |
| --- | --- | --- |
| 从哪里连接 | 同一局域网内的设备 | **任何设备、任何位置——只要能上互联网** |
| 典型场景 | 家里或办公室的手机、平板、第二台电脑 | 不在 Host 身边、跨 NAT、蜂窝网络或公司网络 |
| 前提条件 | Host 与设备在同一网络，防火墙放行监听端口 | Host 能出站访问 CodingNS Control API（HTTPS），你的设备能连上 CodingNS 中转入口 |
| 是否需要账号 | 否 | 需要 CodingNS 账号并绑定 Host |
| 是否暴露本地端口 | 是——在所选网卡和端口上开放监听 | 否——流量走独立设备隧道 |
| 到 Host 的链路 | 你自己网络内的直连 TCP | DSH–CodingNS 中继隧道 |

一句话概括：**局域网访问让你留在本地网络，中转访问服务让你在互联网上的任何位置访问自己的 DSH Web 服务。**

#### 局域网

在 **局域网访问 DSH** 卡片中：

1. 选择 **监听网卡**（最简单是全部网卡 `0.0.0.0`，也可指定具体网卡）；
2. 选择 **监听端口**（默认 `13080`）；
3. 自动探测或手动填写 **本机 DSH Web 端口**；
4. 启动后，在另一台设备打开 `http://<局域网 IP>:<监听端口>`。

注意事项：两台设备需要在同一网络，并放行 Host 防火墙上的监听端口；如果同时运行了多个 DSH 实例，自动探测会列出所有候选端口，需要手动选择。开启 **自动启动** 后，每次 DSH 启动都会恢复该映射。

#### 中转

**这是从本地网络之外访问 DSH 的通道**——只要能上互联网，无论远端设备处于哪个网络都可以。Host 不需要公网 IP、端口映射或 VPN，只需要能出站访问 Control API。

在 **中转访问服务** 卡片中：

1. 填写 **Control API 地址**（默认 `https://channel.codingns.com:1443`，可保存多个地址并切换）；
2. 使用 CodingNS 账号 **登录**；
3. **刷新设备列表** 并选择目标 DSH 设备；
4. **绑定当前 Host**，卡片会显示 Host 标签、公钥和指纹。

在远端设备上通过 CodingNS 入口连接已绑定的 Host，即可像在本地一样使用 DSH Web——会话、终端和工作区都与本地一致，因为它们实际运行在 Host 上。

中转通过独立设备隧道承载 DSH Web 连接：Host 的本地端口不会暴露到互联网，只有你绑定过的 Host 才能被访问，凭据保存在 Host 上。

#### 端到端加密：中转服务看不到你的 DSH 内容

中转链路在设计上就是端到端加密的，使用它并不意味着把对话内容交给服务器。DSH 的流量始终走在 **WebRTC DataChannel 中，由两端之间的 DTLS 保护**——一端是你远端浏览器里的 DSH Client，另一端是你机器上的 DSH Host。隧道不会把业务消息交给 Relay：

- **控制站与 Relay 能处理什么**：账号与设备记录、Host 绑定、ticket、SDP/ICE 信令、在线状态和流量统计——只有控制面元数据。
- **哪些内容端到端加密**：DSH RPC 与模型消息、Agent 输出、终端（PTY）输入输出、任务、文件内容、端口，以及远程 DSH Web 本身。无论两端是直连还是经由 TURN 中转，载荷都保持端到端加密——Relay 始终只转发密文。
- **客户端会校验 Host 身份**：每个 Host 生成并保存自己的 DTLS 证书（`~/.config/dsh-codingns/dtls-identity.json`），并对外发布 SHA-256 指纹；远端在 WebRTC 握手阶段核对指纹，不一致会直接中断连接（`Host DTLS fingerprint 校验失败`），而不是默默接受被替换的证书。同一个指纹也会显示在中转设置卡片中，方便你人工比对。
- **凭据留在 Host**：账号密码只用于登录请求；refresh token 和设备凭据保存在 Host 凭据存储中，不写入浏览器。
- **诊断日志不记录内容**：隧道诊断只记录协议元数据（方向、消息类型、流 ID、状态、字节数），不记录 Envelope 正文、票据、Cookie 或 DSH Web 内容。

这些是隧道的设计硬门禁，而不只是实现细节：控制站与 Relay 只允许处理控制面元数据，Gateway 不得把业务消息交给 Relay，所有 DSH 业务消息必须在 DSH Client 与 DSH Host 之间端到端加密。

#### 安全说明

- 局域网访问只是你自己网络内的明文 TCP 转发，请只在可信网络中使用。
- 中转链路端到端加密（WebRTC/DTLS）：Relay 与控制站只能看到连接元数据，看不到你的 DSH 对话、终端输出或文件内容。
- 中转隧道只有在你登录并绑定 Host 后才工作，退出登录即可断开。
- Agent 凭据不经过 CodingNS，各 CLI 继续使用自己的配置。
- 隧道诊断日志不会记录 Envelope 正文、票据、Cookie 或 DSH Web 内容。

### 设置项参考

设置保存在 DSH 设置文档（`$DSH_HOME/settings.yaml`，默认 `~/.dsh/settings.yaml`）的 `codingns` 命名空间下。建议通过设置页面修改。

| 设置项 | 含义 | 默认值 |
| --- | --- | --- |
| `modules.<模块名>` | 模块启用意图（`cliAdapters`、`workspaceSessionEnhancement`、`terminalEnhancement`、`reverseProxy`、`debug`）。 | 各模块自身默认值 |
| `agentAdapters.<适配器 id>` | 单个 Agent 的启用意图。 | 检测到的 Agent 全部启用 |
| `agentAdapterPreferences.<适配器 id>` | 每个 Agent 最近使用的模型和思考强度。 | 按 Agent 记忆 |
| `cliSessions` | Host 侧外部会话索引（不含凭据和消息）。 | — |
| `lanAccessDsh.autoStart` | DSH 启动时恢复局域网映射。 | `false` |
| `lanAccessDsh.listenHost` / `listenPort` | 监听网卡与端口。 | `0.0.0.0` / `13080` |
| `lanAccessDsh.dshPort` | 本机 DSH Web 端口，`0` 表示自动探测。 | `0` |
| `lan-access-login.json` | 局域网登录保护的用户名、`scrypt` 哈希和盐；仅 Host 当前用户可读写。 | `~/.config/dsh-codingns/` |
| `terminalEnhancement.bindingScope` | `workspace`（按工作区共享终端）或 `session`。 | `workspace` |
| `terminalEnhancement.defaultProfile` | 新终端默认 Shell（`system`、`zsh`、`bash`、`powershell`、`cmd`、`git-bash`）。 | `system` |
| `terminalEnhancement.appearance.*` | 主题、颜色、字体、光标、滚动缓冲区；`null` 表示继承 DSH。 | 继承 |
| `workspaceSessionEnhancement.showAdapterLogo` / `showArchivedSessions` / `showSubscriptionUsage` | 会话行增强开关。 | `true` |
| `controlBaseUrl` / `controlBaseUrls` | 中转 Control API 地址。 | `https://channel.codingns.com:1443` |

### 故障排查

#### 先确认版本

```bash
dsh --version
dsh plugin --profile codingns list --depth 0
npm view dsh-codingns version
```

请保持 DSH 在 `>=0.1.5-rc.3 <0.1.8-0` 范围内。Bundle 的启动胶水会校验运行中的 DSH 版本，对不支持的宿主会拒绝接管连接；这时应升级或降级 DSH，而不是混用版本。

安装脚本和启动胶水都会拒绝不兼容版本：安装阶段由插件和 Profile 的 `preinstall` 检查
当前 `dsh --version`，启动阶段由 Host、Client 和 Bootstrap 再次读取实际 DSH 版本并执行
`assertSupportedDshVersion()`。即使跳过包管理器脚本，插件也不会在不支持的 DSH 上启用。

#### 出现 `patch: entry "terminal-controller" not found`

说明该 Profile 缺少 DSH Web 应用层，通常是因为自定义 Profile 是由插件安装命令本身创建的。请用 `web` 模板重建 Profile 后重新安装：

```bash
dsh codingns --from-default-profile web --dump-config
dsh plugin --profile codingns add dsh-codingns@0.1.1
```

#### 检测不到某个 Agent

- 在 **Host 机器** 的终端里确认命令可用：`claude --version`、`codex --version`、`kimi --version` 等；
- 确认该命令位于 **启动 DSH 的那个进程** 的 `PATH` 中（图形界面启动器的 `PATH` 往往比 Shell 更短）；
- 用各家自己的工具完成登录，CodingNS 只负责启动它；
- 修改 `PATH` 或安装 CLI 后重启 DSH，再重新打开设置卡片。

#### 终端问题

- macOS/Linux 的持久终端需要 `tmux`，缺失时设置卡片会把运行时标记为不可用；安装 tmux 后重启 DSH。
- 启用/停用 **终端强化** 以及修改绑定范围都需要重启 DSH 才能生效；卡片会同时显示当前生效状态和下次启动目标。
- 终端按工作区寻址；如果终端看起来属于另一个会话，请检查绑定范围设置。

#### 局域网访问连不上

- 确认监听已启动：卡片会显示 `转发：<host>:<port> → DSH Web 127.0.0.1:<dshPort>`；
- 放行 Host 防火墙上的监听端口，并确认两台设备在同一网络且能访问 Host 的 IP；
- 自动探测不到端口时，先启动 DSH Web，再手动填写 DSH 端口。

#### 中转登录或绑定失败

- 检查 Control API 地址，以及 Host 能否通过 HTTPS 访问它；
- 会话过期时重新登录，然后刷新设备列表；
- 需要先绑定 Host，隧道才会接受连接；卡片会显示已绑定 Host 的标签和指纹。

#### 诊断日志

隧道诊断默认关闭，可以通过环境变量开启：

```bash
DSH_CODINGNS_TUNNEL_DEBUG=1 dsh codingns --no-open
```

诊断记录包含连接方向、消息类型、流 ID、操作、作用域、状态和字节数；不会记录 Envelope 正文、票据、Cookie 或 DSH Web 内容。插件安装（pnpm）日志位于 `$DSH_HOME/profiles/<profile>/.plugin-manager/logs/`。

#### 反馈问题

请附上 DSH 版本、CodingNS 版本、操作系统、使用的模块、期望结果、实际结果和完整错误信息。反馈渠道：[GitHub Issues](https://github.com/jingyi0605/DSH-CodingNS/issues) 或 QQ 群 **1092985965**。

### 路线图

以下为后续版本的规划，属于设计目标而非当前版本的承诺：

- **PeerHost**：Host 之间的直接资源发现与协作。
- **文件管理功能增强**：工作区内浏览、搜索、上传、下载和常用文件操作。
- **工作区会话功能增强**：更深入的会话组织、筛选、元数据和跨设备同步。
- **调试服务反向代理完善**：在现有仅 HTTP 代理的基础上加入鉴权绑定与 WebSocket 支持。
- **GIT 管理**：仓库状态、分支、提交、差异和常用 Git 操作。
- **SKILL 管理**：发现、安装、启用、停用和更新可复用的 Agent 技能。
- **更多**：由社区反馈驱动的其他工作区自动化与协作模块。

### 开发

环境要求：Node.js `>= 22.19` 与 pnpm。

```bash
pnpm install
pnpm build       # 版本校验 → tsc → Client Bundle → H5 Bundle
pnpm test        # 先构建，再运行 node --test tests/*.spec.ts
pnpm typecheck   # tsc --noEmit
```

常用脚本：

| 脚本 | 作用 |
| --- | --- |
| `pnpm build` | 清理 `data/build/`，产出 TypeScript、浏览器 Client Bundle 和 H5 入口。 |
| `pnpm test` | 完整构建并运行 `tests/` 下的测试。 |
| `pnpm dev:link <profile>` | 把当前检出目录软链到 `$DSH_HOME/profiles/<profile>/node_modules`。 |
| `pnpm dev:watch` | 监听并增量构建；构建后重启 DSH 即可看到效果。 |
| `pnpm run version:check` | 校验 `version.json`、源码与清单中的版本一致。 |
| `pnpm run version:set-plugin -- <版本>` | 更新插件版本。 |
| `pnpm run version:set-dsh -- <版本> [兼容范围]` | 更新已验证的 DSH 版本与兼容范围。 |

目录结构：

| 路径 | 内容 |
| --- | --- |
| `src/host/` | Host 层：Agent 适配器、终端控制器、局域网监听、登录、中继/设备运行时、调试服务、RPC 表。 |
| `src/client/` | 浏览器层：设置卡片、终端 UI、输入框插槽、会话行增强、调试面板、多语言与主题。 |
| `src/shared/contracts/` | 两端共用的版本、设置、功能模块、Agent、终端与调试契约。 |
| `src/features/` | 功能模块注册表：依赖排序、状态迁移与资源释放。 |
| `src/transport/` | DSH Transport/Tunnel：Envelope、分帧、多路复用、WebRTC 承载与诊断。 |
| `tests/` | 58 个测试套件，覆盖契约、模块、终端后端、传输与浏览器行为。 |
| `specs/`、`docs/` | 设计记录以及模块/界面开发规范。 |
| `profile/` | CodingNS 桌面壳使用的参考 Profile，只选择 CodingNS Bundle。 |
| `data/build/` | 构建产物（已被 git 忽略，由 `pnpm build` 生成）。 |

发布流程：推送 `v*` tag 会触发 GitHub Actions，校验 tag 与 `version.json`、使用冻结锁文件安装、执行类型检查与测试、检查打包内容，并以 provenance 方式发布到 npm（预发布版本使用 `next` dist-tag）。

### 社区与反馈

- QQ 讨论群：**1092985965**
- 代码仓库：[github.com/jingyi0605/DSH-CodingNS](https://github.com/jingyi0605/DSH-CodingNS)
- npm 包：[`dsh-codingns`](https://www.npmjs.com/package/dsh-codingns)
- 问题与建议：[GitHub Issues](https://github.com/jingyi0605/DSH-CodingNS/issues)

反馈问题时请附上 DSH 版本、CodingNS 版本、操作系统、启用的模块和完整错误信息。
