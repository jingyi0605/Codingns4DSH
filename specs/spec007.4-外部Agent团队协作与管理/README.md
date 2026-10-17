# Spec007.4: External Agent Team collaboration and management

Current live assessment: the [Command Code/Grok correction record](specs/spec007.4-外部Agent团队协作与管理/docs/20261017-CommandCode与Grok团队故障修复记录.md) records six passed ordinary/Team collaborator/Team Lead workflows, including follow-ups, on DSH `0.2.1-rc.2`. It covers ACP Mod startup, scoped Grok permissions, fetched model selection, and cold follow-up status; 210 focused/compatibility tests passed. The earlier [all-adapter matrix](specs/spec007.4-外部Agent团队协作与管理/docs/20261017-Stage0全适配器团队与委派验收记录.md) retains pre-correction failures and other installation/certification limits. Claude Code remains excluded from these live follow-ups.

Status: Complete on 2026-10-17 within the recorded validation scope. The standard build/test suite and headless native/external Codex/Claude reference acceptance passed on both target runtimes. Planning document submitted in local commit `10bd749`; final evidence is recorded in the task list.

Follow-up: user-supplied OpenCode/Codex exports exposed native child effort inheritance, internal translation cancellation, and dropped child settlement input. The [session regression record](specs/spec007.4-外部Agent团队协作与管理/docs/20261017-团队会话故障回归记录.md) distinguishes export evidence, deterministic reproductions, and live-validation limits; verification is tracked in task 4.1.

Stage0 follow-up: the user explicitly authorized enabling translation and direct Team testing. OpenCode Lead → Codex, Codex Lead → real native DSH, and Codex Lead → Codex each passed initial/follow-up rounds on alpha.3, including a translation settings refresh and mixed human/Team input. The [Stage0 integration record](specs/spec007.4-外部Agent团队协作与管理/docs/20261017-会话翻译与团队协作联调记录.md) records fixes, real translation evidence, and the final 3,547-pass source result; verification is tracked in task 4.2.

Grok follow-up: a supplied teammate export exposed redundant Team-tool approval under inherited `workspace-write` / `never`. The scoped admission fix passed a fresh Codex Lead → Grok collaborator initial/follow-up case on Stage0 alpha.3. The full source suite passed 3,561 tests with 15 skips and zero failures; both target native TeamService fixtures passed separately. The [Grok regression record](specs/spec007.4-外部Agent团队协作与管理/docs/20261017-Grok队友权限故障回归记录.md) records the failure chain and verification; task 4.3 is complete.

Claude retry follow-up: a supplied teammate export and its matching CLI transcript exposed HTTP 502 retries being interpreted as terminal failures. Claude's `system/api_retry` notifications now leave the existing invocation alive until its actual outcome. Ordinary sessions, Leads, and teammates pass the new protocol replays; the affected suite passed 104 tests with two skips and zero failures. The [Claude retry regression record](specs/spec007.4-外部Agent团队协作与管理/docs/20261017-Claude重试通知误判故障回归记录.md) distinguishes the parser fix from upstream availability and live-validation limits; task 4.4 is complete.

An external Agent should be able to work as a named DSH teammate or execute the top-level Team Lead session. DSH remains responsible for membership, tasks, authority, persistence, and child lifecycle. CodingNS connects that real DSH identity to an external adapter and exposes the appropriate Team tools.

The user authorized this Spec workflow after selecting **DSH `0.2.1-alpha.2` as the minimum for full Team support**. The initial certification targets are alpha.2 and alpha.3. The plugin-wide compatibility range remains `>=0.2.0-rc.2 <=0.2.1-alpha.3`; ordinary external sessions and existing subagent delegation on rc.2/alpha.1 remain supported. Future DSH versions require a separate compatibility review.

## Documents

- [Requirements](specs/spec007.4-外部Agent团队协作与管理/requirements.md): user stories, scope, and acceptance criteria.
- [Design](specs/spec007.4-外部Agent团队协作与管理/design.md): ownership, interfaces, message forwarding, and compatibility.
- [Tasks](specs/spec007.4-外部Agent团队协作与管理/tasks.md): implementation order, dependencies, and verification evidence.
- [Investigation](docs/调查报告/20261017-外部Agent团队协作与管理兼容性调查.md): repository findings and the four-version upstream comparison. This report is local under the existing `.gitignore`; the version policy and implementation findings are also captured in the Spec documents.
- [Supporting material index](specs/spec007.4-外部Agent团队协作与管理/docs/README.md).
- [Development and verification record](docs/开发记录/20261017-外部Agent团队协作与管理开发记录.md): implementation choices, adapter assessment, and actual verification evidence; local under the existing documentation ignore rules.

## Delivery scope

- DSH Lead with external teammates, external Lead with native teammates, and external Lead with external teammates.
- Named roster membership, peer messages, shared-task operations, bounded waits, and Lead-authorized spawning, reassignment, and interruption.
- Reuse the existing native continuation providers, external drivers, session bindings, tool injection, and native Team panel.
- Per-adapter eligibility and certification. Codex and Claude Code provide the first reference workflows; other registered external providers are evaluated individually before advertising support.
- Explicit diagnostics for old DSH versions, a missing Team profile, disabled bridge infrastructure, unsupported adapters, and unavailable runtimes.

Implementation does not create a second task board, promote a teammate to Lead, introduce multiple Leads, add nested Teams, add remote members or worktrees, or implement external fork-history semantics. An external CLI without a real DSH session is outside this scope.

## Adapter eligibility

This table describes source and transport eligibility. It is not a live CLI certification statement. Both roles require an installed, enabled Agent, the existing CodingNS subagent bridge setting, and the native DSH Team services. The Agent details dialog reports missing prerequisites.

| Adapter | Collaborator | Lead | Tool transport and constraints |
| --- | --- | --- | --- |
| DSH | Yes | Yes | Native `agent_team`; native DSH model route must be available and unambiguous |
| Codex | Yes | Yes | MCP; exact thread resume and peer steer have protocol tests |
| Claude Code | Yes | Yes | MCP; native Task/Agent tools blocked; peer input follows the retained stream boundary |
| Command Code | Yes | Yes | Local Mod in ACP and legacy execution; one Team tool, no duplicate MCP route; Stage0 rc.2 both-role initial/follow-up acceptance passed |
| OpenCode | Yes | Yes | Per-session MCP registration; native task delegation remains blocked; Stage0 alpha.3 initial/follow-up acceptance passed |
| Gemini | Yes | Yes | ACP with MCP; Team failure does not enter the legacy stream fallback |
| Grok Build | Yes | Yes | ACP with MCP; Team load failure does not create another session; Stage0 alpha.3 collaborator and rc.2 both-role initial/follow-up acceptance passed |
| MiniMax Code | Yes | Yes | ACP with MCP at default effort; explicit non-default Team effort is rejected |
| Kimi, Pi, Zcode | No | No | Existing continuation providers lack the required Team tool transport |
| CodeBuddy, WorkBuddy, Cursor, Kiro, Qoder/Qoder CN, Antigravity, Doubao | No | No | Outside the current continuation-provider allowlist; ordinary sessions remain available |

All Team credentials are launch-scoped and revoked when the native Agent or Team service is replaced. Shared checkout write scopes are advisory. Message acceptance and inactive status do not complete a task. Historical queued mailbox sends are not automatically replayed.

## Verification and remaining certification

Final `pnpm test` passed 3,536 tests with 14 explicit skips and zero failures, including its full build. Earlier source verification passed 3,524 tests, followed by 566 driver/Team/translation regressions. Typecheck, capability, version, localization, and whitespace checks passed. Real TeamService integration tests passed on both installed target versions. Detailed evidence is recorded in the task list.

Opt-in live checks used separate temporary DSH installations, real DSH core/Team/persistence/activation services, and real Codex/Claude CLI sessions. Native DSH model responses came from an explicit deterministic test adapter; no native cloud-provider claim or browser/GUI acceptance is implied. On both alpha.2 and alpha.3, native Lead → Codex/Claude, Codex/Claude Lead → native DSH, Codex Lead → Claude, and Claude Lead → Codex passed. Codex Lead → Codex passed as an additional case. Codex lifecycle checks also passed idle wake-up, cold resume of the same provider conversation, revoked/replaced launch credentials, scoped interruption, and preservation of existing tasks on both versions.

Early Claude probes timed out at 150 seconds and one lightweight alias returned `server_error`. A plain-text baseline worked. Investigation found and fixed a terminal-result cleanup bug in the shared stream driver, and a regression verifies cleanup without waiting for stdout EOF. Final reference runs used the existing default-model alias, low effort, isolated CodingNS MCP configuration, and an explicit 600-second test budget; all required workflows passed. These are test settings, not changes to saved Claude configuration or production Team deadlines.

Subsequent authorized Stage0 alpha.3 tests used real configured translation/native models and OpenCode/Codex CLIs, with no deterministic native fixture. OpenCode → Codex, Codex → native DSH, and Codex → Codex passed both rounds, preserving a completed task at revision 3 on follow-up. The Codex-only stress case also translated a human instruction in the same native step as three Team messages while translation settings were refreshed/restored. The full source suite after these fixes passed 3,547 tests with 14 explicit skips and zero failures; focused tests passed 174. A later Codex → Grok case passed both rounds under inherited `workspace-write` / `never`, with no redundant Team approval request. At that checkpoint, Grok's Lead role and Command Code/Gemini/MiniMax roles remained source/protocol-qualified. Task 4.6 subsequently passed Command Code/Grok ordinary and both Team-role initial/follow-up cases on rc.2, with 210 focused/compatibility tests passing. Gemini/MiniMax live limits remain in the all-adapter matrix. These follow-ups do not extend OpenCode/Grok live certification to alpha.2.

The reproducible, opt-in runner is `scripts/verify-agent-team-runtime.mjs`. It accepts only dedicated `/tmp/codingns-spec0074-runtime-*` installations and checks their exact version. It uses unique homes, disables Codex Computer Use and telemetry, isolates Claude's MCP configuration, and closes the resources it starts. Example:

```bash
node scripts/verify-agent-team-runtime.mjs /tmp/codingns-spec0074-runtime-EXAMPLE/0.2.1-alpha.3 0.2.1-alpha.3 native-codex lifecycle
```

Execution requires the authorization described below and working external Agent logins; the example is not an automatic development step.

The separate `scripts/verify-stage0-team-translation.mjs` runner requires an explicitly authorized Stage0 test. It verifies the listener's repository patch, profile, and home, authenticates using its private startup log, and retains native journals and translation/task evidence. It is not an automatic development step.

## Relationship to earlier Specs

For this native integration, Spec007.4 replaces the standalone `CodingNSAgentTeam` orchestration direction in `specs/spec007-AgentTeam外部Agent适配器原生集成/`. That older plan remains historical material; its unchecked tasks are not this implementation schedule.

This Spec builds on the capability boundary in Spec005, the continuation/provider integration in Spec007.2, and the ordinary delegation behavior in Spec011. It preserves their existing non-Team workflows.

## Execution boundary

The user requested submission of this plan followed by completion of development on 2026-10-17. The plan was committed locally; implementation and follow-up fixes are now grouped into separately authorized local commits. The user subsequently selected isolated acceptance in the native question panel, authorizing builds, temporary alpha.2/alpha.3 installations and their test lifetimes, and bounded Codex/Claude calls using existing logins. Those isolated application processes were closed.

The later explicit request to enable Stage0 translation and directly test Teams authorized configuration changes and live/cold-start testing of the verified `/Users/jackson/.dsh-stage0-020` home, `stage0` profile, and repository-linked instance. Stage0 remains running with translation enabled, and test sessions/evidence are retained. The user then authorized committing only this session's changes, grouped by functionality and following existing commit-message conventions. Pushes and releases remain outside authorization. DSH Desktop isolation remains absolute under `AGENTS.md`.
