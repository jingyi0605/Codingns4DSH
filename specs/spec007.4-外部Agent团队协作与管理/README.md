# Spec007.4: External Agent Team collaboration and management

Status: Accepted for implementation on 2026-10-17.

An external Agent should be able to work as a named DSH teammate or execute the top-level Team Lead session. DSH remains responsible for membership, tasks, authority, persistence, and child lifecycle. CodingNS connects that real DSH identity to an external adapter and exposes the appropriate Team tools.

The user authorized this Spec workflow after selecting **DSH `0.2.1-alpha.2` as the minimum for full Team support**. The initial certification targets are alpha.2 and alpha.3. The plugin-wide compatibility range remains `>=0.2.0-rc.2 <=0.2.1-alpha.3`; ordinary external sessions and existing subagent delegation on rc.2/alpha.1 remain supported. Future DSH versions require a separate compatibility review.

## Documents

- [Requirements](specs/spec007.4-外部Agent团队协作与管理/requirements.md): user stories, scope, and acceptance criteria.
- [Design](specs/spec007.4-外部Agent团队协作与管理/design.md): ownership, interfaces, message forwarding, and compatibility.
- [Tasks](specs/spec007.4-外部Agent团队协作与管理/tasks.md): implementation order, dependencies, and verification evidence.
- [Investigation](docs/调查报告/20261017-外部Agent团队协作与管理兼容性调查.md): repository findings and the four-version upstream comparison. This report is local under the existing `.gitignore`; the version policy and implementation findings are also captured in the Spec documents.
- [Supporting material index](specs/spec007.4-外部Agent团队协作与管理/docs/README.md).

## Delivery scope

- DSH Lead with external teammates, external Lead with native teammates, and external Lead with external teammates.
- Named roster membership, peer messages, shared-task operations, bounded waits, and Lead-authorized spawning, reassignment, and interruption.
- Reuse the existing native continuation providers, external drivers, session bindings, tool injection, and native Team panel.
- Per-adapter eligibility and certification. Codex and Claude Code provide the first reference workflows; other registered external providers are evaluated individually before advertising support.
- Explicit diagnostics for old DSH versions, a missing Team profile, disabled bridge infrastructure, unsupported adapters, and unavailable runtimes.

Implementation does not create a second task board, promote a teammate to Lead, introduce multiple Leads, add nested Teams, add remote members or worktrees, or implement external fork-history semantics. An external CLI without a real DSH session is outside this scope.

## Relationship to earlier Specs

For this native integration, Spec007.4 replaces the standalone `CodingNSAgentTeam` orchestration direction in `specs/spec007-AgentTeam外部Agent适配器原生集成/`. That older plan remains historical material; its unchecked tasks are not this implementation schedule.

This Spec builds on the capability boundary in Spec005, the continuation/provider integration in Spec007.2, and the ordinary delegation behavior in Spec011. It preserves their existing non-Team workflows.

## Execution boundary

The user requested submission of this plan followed by completion of development on 2026-10-17. Submit the planning documents in a local Git commit, then implement and run source-based verification. Builds, development-server startup, application operations, pushes, and releases remain subject to their explicit authorization rules. Any Stage0 runtime acceptance follows the authorization recorded for that action. DSH Desktop isolation remains absolute under `AGENTS.md`.
