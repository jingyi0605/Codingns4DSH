<div align="center">

# DSH-CodingNS for DeepSeek Harness

**External Agent CLIs, persistent terminals, workspace debug and remote access — inside DSH's own UI.**

[![npm version](https://img.shields.io/npm/v/dsh-codingns?logo=npm)](https://www.npmjs.com/package/dsh-codingns)
[![DSH compatibility](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.3%20%3C0.1.8--0-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-3C873A?logo=node.js&logoColor=white)](https://nodejs.org)

[简体中文](README.md) · **English**

**Current release `dsh-codingns@0.1.1`** · DSH **`>=0.1.5-rc.3 <0.1.8-0`** (validated `0.1.6-alpha.2`) · Node **`>= 22.19`** · macOS / Linux / Windows

**[GitHub](https://github.com/jingyi0605/DSH-CodingNS)** · **[npm](https://www.npmjs.com/package/dsh-codingns)** · **QQ group 1092985965**

<p>
  <a href="#interface-preview">Preview</a> ·
  <a href="#what-is-dsh-codingns">What it is</a> ·
  <a href="#supported-agents">Agents</a> ·
  <a href="#feature-details">Features</a> ·
  <a href="#installation">Install</a> ·
  <a href="#first-run">First run</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#development">Development</a> ·
  <a href="#acknowledgements">Acknowledgements</a>
</p>

</div>

## Interface Preview

<div align="center">
  <img width="90%" src="assets/screenshots/agent-picker.jpg" alt="The composer Agent picker and the session sidebar with per-Agent logos">
</div>

The composer Agent picker — the built-in DeepSeek Harness plus every installed external Agent; the sidebar keeps per-Agent logos and an archived-session entry.

---

## What is DSH-CodingNS

**DSH (DeepSeek Harness)** is DeepSeek's coding-agent harness — a CLI plus Web UI that runs an agent loop inside your workspace.

**DSH-CodingNS is a DSH plugin bundle** (Host + browser layers) adding seven modules, all configured under **Settings → CodingNS**.

> Naming: this plugin is **DSH-CodingNS** (npm package `dsh-codingns`; its settings entry is labelled CodingNS). **CodingNS** on its own refers to the platform service that provides the Control API, accounts and the relay tunnel.

| Module | What it does | Default |
| --- | --- | :---: |
| **External Agent integration** | Run installed Agent CLIs as native DSH sessions: streaming, tools, approvals, questions, usage, thinking levels | On |
| **Workspace session enhancement** | Agent logos on session rows, archived-session entry, subscription/usage readout | Off |
| **Terminal enhancement** | Persistent terminals plus shell, theme, font, cursor and scrollback settings | Off · restart |
| **LAN access to DSH** | Listener forwarding a LAN address to the local DSH Web port | Always on |
| **Login protection** | One optional local account guarding LAN **and** relay access; loopback always allowed | Always on (card) |
| **Relay access service** | **Your DSH Web from anywhere on the internet**, end-to-end encrypted | Off |
| **Workspace debug** | Per-workspace launch profiles, port checks, HTTP service proxy | On |

Nothing native is replaced — conversations, sessions, sidebar, settings and approvals stay DSH's own.

Everything runs on the **Host** (your machine): Agents, terminals, files, LAN/relay listeners; the browser is only a view. Agent CLIs run as DSH child processes with their own credentials and providers — model traffic never goes through DSH-CodingNS. Remote access is available through optional modules.

Notes: the sidebar terminal exists as soon as the plugin is installed — **Terminal enhancement** only switches it to the persistent backend (tmux on macOS/Linux, ConPTY on Windows) and applies on restart; on DSH `0.1.5.x` DSH-CodingNS runs in compatibility mode (no multi-tab or shell selection) and the cards say so; the 调试 card is currently Chinese-only.

---

## Supported Agents

Detected on the Host by command name; version and models come from the CLI itself. Detected Agents are enabled by default and can be toggled individually. The built-in **DeepSeek Harness** Agent is always available.

| Agent | id | Command | Protocol | Capabilities |
| --- | --- | --- | --- | --- |
| Command Code | `command-code` | `command-code`, `commandcode`, `cmdc` | single-shot CLI | models, streaming, resume, interrupt, tools, thinking, usage |
| Claude Code | `claude-code` | `claude` | stream-json | models, streaming, resume, interrupt, tools, thinking, usage |
| Kimi CLI | `kimi` | `kimi`, `kimi-cli` | stream-json | all of the above + approvals, questions, steering |
| Gemini CLI | `gemini` | `gemini` | ACP | models, streaming, resume, interrupt, tools, thinking, usage, approvals |
| Pi Agent | `pi` | `pi`, `pi-agent` | JSON-RPC | models, streaming, resume, interrupt, tools, thinking, usage, steering |
| Codex | `codex` | `codex` | JSON-RPC (app-server) | all + approvals, questions, steering |
| OpenCode | `opencode` | `opencode`, or `OPENCODE_SERVER_URL` (default `http://127.0.0.1:4096`) | HTTP + SSE | all + approvals, questions |
| Grok Build | `grok` | `grok`, `grok-build` | ACP | models, streaming, tools, thinking, usage, approvals |

**models** model list · **streaming** live output · **resume** continue after restart · **interrupt** cancel a turn · **tools** tool calls in the conversation · **thinking** reasoning/effort · **usage** token or subscription limits · **approvals / questions** native DSH interactions · **steering** inject a message mid-turn.

Unlisted capabilities are unsupported by that CLI or version. Install and log in to each Agent outside DSH; DSH-CodingNS never stores Agent credentials.

---

## Feature Details

### External Agent Integration

After you pick an Agent and a model, DSH-CodingNS starts (or resumes) that CLI as a DSH child process and projects its event stream into a native session; the model and thinking effort are remembered per Agent.

<div align="center">
  <img width="70%" src="assets/screenshots/model-picker.jpg" alt="The Codex model list">
</div>

The model list is read from each CLI and can be switched at any time; the composer button also shows the current model and thinking effort.

### Session Enhancement and Usage

Session rows show the Agent logo and archive entry, and the composer dock shows subscription or upstream usage for Agents whose limits can be read (cache hit rate, per-model stats and cost included).

<div align="center">
  <img width="70%" src="assets/screenshots/subscription-usage.jpg" alt="Codex upstream usage and cost statistics">
</div>

Usage comes from the Agent's own quota API or a configured upstream source; it is read on the Host and never stored in the browser.

### Workspace Debug

Each workspace keeps its own launch profiles (`<workspace>/.codingns/debug.json`): command, working directory, environment, shell and an optional port — start, check the port, kill the process or stop it. An optional reverse proxy exposes the port through DSH (HTTP only for now).

<div align="center">
  <img width="70%" src="assets/screenshots/workspace-debug.jpg" alt="Workspace debug panel: launch profiles, port state and proxy">
</div>

The panel shows live port state and PID, and issues an unguessable proxy URL per running instance.

### Modules and Settings

The settings page renders one card per module — switch, description and restart notice all come from the module itself; terminal appearance, LAN mapping, login protection and relay account are configured inside their own cards.

| <img src="assets/screenshots/settings-overview.jpg" alt="Settings → CodingNS module cards"> | <img src="assets/screenshots/settings-modules.jpg" alt="All module switches"> |
| --- | --- |
| One card per module with its own switch | All seven modules plus the version footer |

### Login Protection

Off by default; once enabled on its card, one local account guards LAN **and** relay access (default session timeout 30 minutes). Authentication happens at the Host's forwarding boundary, so unauthenticated traffic never reaches DSH Web; `127.0.0.1` and `::1` are always allowed to prevent lockout.

<div align="center">
  <img width="70%" src="assets/screenshots/login-protection.jpg" alt="Local account login page">
</div>

The password is `scrypt`-hashed in a `0600` file, and the browser only holds an `HttpOnly`, `SameSite=Strict` session cookie.

### Remote Access

| | LAN access | Relay access |
| --- | --- | --- |
| Connect from | Same local network | **Any device, anywhere on the internet** |
| Needs | Shared network + open listen port | Host can reach the Control API over HTTPS; your device can reach the CodingNS entry |
| Local port exposed | Yes — chosen interface/port (default `13080`) | No — isolated device tunnel |
| Account | Optional login protection | CodingNS account + bound Host |

**LAN**: pick a listen interface and port, auto-detect (or type) the local DSH Web port, start, then open `http://<lan-ip>:<port>` from another device; auto-start restores the mapping, and the module patches the `crypto.randomUUID` that plain-HTTP origins need.

**Relay**: set the Control API (default `https://channel.codingns.com:1443`, where you can register), log in, refresh devices, bind the current Host (label, public key, fingerprint), then open the bound Host from any device through **`https://dsh.codingns.com`** — no public IP, port forwarding or VPN.

| <img src="assets/screenshots/relay-service.jpg" alt="Relay access card"> | <img src="assets/screenshots/relay-h5-login.jpg" alt="H5 login page: choose a DSH Host"> |
| --- | --- |
| Relay card: address, account, device list and the H5 login address | Pick the bound Host from any device and connect |

The account entry next to DSH's Settings button shows login state, access path and latency, host CPU/memory, and offers one-click logout.

<div align="center">
  <img width="45%" src="assets/screenshots/relay-status.jpg" alt="Account status popover: access path, latency, CPU and memory">
</div>

The “access” line tells you whether you entered DSH Web locally, over the LAN or through the relay.

**Why the relay cannot read your DSH traffic** — the tunnel is end-to-end encrypted, so using it never hands your conversations to a server:

- Payload travels in a **WebRTC DataChannel protected by DTLS between the DSH Client and the DSH Host**; direct or via TURN, only ciphertext crosses the relay.
- The relay and control service handle **control-plane metadata only**: account/device records, Host binding, tickets, SDP/ICE signaling, online state, traffic accounting.
- Each Host keeps its own DTLS certificate (`~/.config/dsh-codingns/dtls-identity.json`) and publishes a SHA-256 fingerprint the remote side verifies during the handshake — a mismatch aborts the connection (`Host DTLS fingerprint 校验失败`) instead of accepting a substituted certificate; the same fingerprint shows in the relay card for manual comparison.
- Passwords are used only for login requests; refresh token and device credential stay on the Host. Diagnostics log protocol metadata only (direction, type, stream id, status, bytes) — never bodies, tickets, cookies or DSH Web content.

---

## Installation

**Requirements**: DSH inside `>=0.1.5-rc.3 <0.1.8-0` (plugin and DSH versions ship independently; both the installer and the runtime reject unsupported versions) · Node.js `>= 22.19` · `pnpm` on `PATH` (`dsh plugin` forwards to pnpm) · optional: Agent CLIs, and `tmux` on macOS/Linux for persistent terminals (`brew install tmux` / `sudo apt install tmux`).

DSH-CodingNS needs a profile that also contains the DSH Web application layer, so create the profile from the shipped `web` template first:

```bash
dsh codingns --from-default-profile web --dump-config   # create profile (prints layers, does not start)
dsh plugin --profile codingns add dsh-codingns@0.1.1    # install the bundle
dsh codingns                                            # start DSH
```

Or install into the standard web profile: `dsh plugin --profile web add dsh-codingns@0.1.1`, then `dsh web`.

- **Do not** create a fresh profile with the plugin as its first command: a new custom profile only contains `@deepseek-ai/dsh-base`, so the patch reports `entry "terminal-controller" not found` and there is no browser UI.
- A registry 404 means that version is not published yet — use the source install below.

```bash
# verify
dsh plugin --profile codingns list --depth 0     # -> dsh-codingns <version>
dsh --profile codingns --dump-config             # expect id: dsh-codingns, terminal-controller disabled

# upgrade, pin, uninstall (restart DSH afterwards)
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

**State on disk**: settings live in `$DSH_HOME/settings.yaml` (default `~/.dsh/settings.yaml`) under the `codingns:` namespace.

| Path | Contents |
| --- | --- |
| `$DSH_HOME/profiles/<profile>` | Installed plugin packages and `dsh.profile.bundles` |
| `$DSH_HOME/dsh-codingns/` | Terminal `host-id` and `terminals.json` (restore mapping) |
| `~/.config/dsh-codingns/` | Relay credentials, DTLS identity, login-protection hash |
| `<workspace>/.codingns/debug.json` | Debug launch profiles (mode `0600`, secrets rejected) |

---

## First Run

1. `dsh codingns` opens the DSH Web UI.
2. Open **Settings → CodingNS** to review the module cards (restart-required ones show both the effective and next-start state).
3. Install and log in to your Agent CLIs **outside** DSH, keep them on the Host `PATH`, then enable them in **外部Agent集成**.
4. Pick an Agent, model and thinking level in the composer and send a prompt — output streams into a native session with the Agent's logo.
5. Right sidebar: Terminal for a workspace shell (enable **终端强化** + restart for persistence); 调试 to add a launch profile and watch its port.
6. For remote use, turn on **登录保护**, configure **局域网访问DSH**, or log in to **中转访问服务** to connect from any network; the account entry shows the current path and host load.

---

## Troubleshooting

- **Versions** — `dsh --version`, `dsh plugin --profile codingns list --depth 0`, `npm view dsh-codingns version`; install and startup both reject DSH outside the supported range.
- **`patch: entry "terminal-controller" not found`** — the profile lacks the Web app layer; recreate it from the `web` template as shown above.
- **Agent not detected** — run `<cli> --version` on the Host; ensure its directory is on the `PATH` of the process that started DSH (GUI launchers often differ); log in with the vendor tool, then restart DSH.
- **Terminal** — persistent mode needs `tmux` on macOS/Linux; enabling/disabling the module and changing the binding scope need a restart; terminals are addressed per workspace.
- **LAN** — check the card's forwarding line, allow the port through the firewall, keep both devices on one network; with several DSH instances pick the detected port manually; sign in first when login protection is on.
- **Relay** — verify Control API reachability, log in again if the session expired, refresh devices, then bind the Host.
- **Logs** — `DSH_CODINGNS_TUNNEL_DEBUG=1 dsh codingns --no-open` (metadata only); pnpm install logs live in `$DSH_HOME/profiles/<profile>/.plugin-manager/logs/`.
- **Reporting** — include DSH and DSH-CodingNS versions, OS, module and exact error: [GitHub Issues](https://github.com/jingyi0605/DSH-CodingNS/issues) or QQ **1092985965**.

---

## Development

Requires Node `>= 22.19` and pnpm:

```bash
pnpm install
pnpm build            # version check -> tsc -> client + H5 bundles
pnpm test             # build, then 61 suites under tests/
pnpm typecheck
pnpm run capability:check   # capability retirement check
```

Dev loop: `pnpm dev:watch` with `pnpm dev:link <profile>`, then restart DSH. Versions come from `version.json` (`version:set-plugin` / `version:set-dsh`, guarded by `version:check`).

Layout: `src/host` (Host layer), `src/client` (browser layer), `src/dsh-capabilities` (capability registry and version routing), `src/shared/contracts`, `src/transport` (tunnel + WebRTC), `src/features` (module registry), `tests/`, `specs/`, `docs/`, `data/build` (git-ignored).

A `v*` tag runs GitHub Actions (tag/version check, frozen install, typecheck, tests, `npm pack`) and publishes with provenance; prereleases get the `next` dist-tag. Roadmap: PeerHost, file management, workspace sessions, debug-proxy completion (auth + WebSocket), Git, SKILL, more.

Screenshot assets and shot list: [assets/screenshots](assets/screenshots/README.md) (Chinese).

**Chinese version: [README.md](README.md)**

---

## Acknowledgements

The inspiration for DSH-CodingNS — and part of its implementation approach — comes from **[CodexHost](https://github.com/BytePioneer-AI/codex-host)**, which runs Pi, Claude Code, Grok Build and other Harnesses natively inside Codex Desktop. It showed the direction DSH-CodingNS follows from the other side: host *other* Harnesses as first-class Agents instead of replacing them. The multi-Harness adapter model, projecting a CLI event stream into native sessions, and keeping each Agent's sessions in the host sidebar and composer trace back to that design. Thanks to its authors and community.

DSH-CodingNS is an independent project and is not affiliated with CodexHost.
