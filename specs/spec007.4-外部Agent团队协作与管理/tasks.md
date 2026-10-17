# Tasks: External Agent Team collaboration and management

Status: Original development, session-export regressions, authorized Stage0 translation/Team integration, and the Grok teammate permission follow-up are complete. All 14 tasks have verification evidence. No release or publication was performed; Desktop remains outside scope.

Planning submission: local commit `10bd749` (`docs: submit spec007.4 external agent team implementation plan`). No push was requested or performed.

Local delivery (2026-10-17): the user subsequently authorized functional commits of this session's changes using existing commit-message conventions. Unrelated README edits remain uncommitted. Earlier execution boundaries below describe their respective verification checkpoints; no push or release was authorized.

Only mark a task `[x]` after its verification evidence is recorded. States: `TODO`, `IN_PROGRESS`, `BLOCKED`, `IN_REVIEW`, `DONE`, `CANCELLED`. Blocked/cancelled tasks must state the cause. Update this file after each completed task.

All document paths below are repository-root-relative. Requirements and design section references refer to this Spec's main documents. Proposed implementation/test filenames may be adjusted to existing repository conventions without widening scope.

## Phase 0: Establish the plan

- [x] 0.1 Record scope, source evidence, and compatibility decisions
  - State: DONE.
  - Work: create requirements, design, this task list, and the dated upstream/repository investigation; link the new Spec from the repository and earlier Team plan.
  - Result: one implementation entry with alpha.2 as the full-Team minimum and native DSH ownership.
  - Dependencies: user authorization to start Spec007.4 and the preceding source investigation.
  - Read: `AGENTS.md`; `specs/000-Spec规范/Spec模板/`; `docs/调查报告/20261017-外部Agent团队协作与管理兼容性调查.md`.
  - Files: this Spec; dated investigation; root README; Spec007 README.
  - Excludes: production changes, builds, servers, live Agents, Desktop, commits, and releases.
  - Complete when: requirements/design/tasks agree, local links resolve, and the diff contains only authorized documentation.
  - Verify: document/link/status review and `git diff --check`.
  - Evidence (2026-10-17): six new Markdown documents reviewed; all five local Markdown links resolved; all 11 tasks contained the required execution/verification fields; version and ownership policies agreed; `git diff --check` passed. The investigation is local under the existing ignored `docs/调查报告/` directory; no ignore or staging rule was changed. Final checks are recorded below.
  - Trace: R1–R8; design §1–9.

## Phase 1: Capability and authorized Team calls

- [x] 1.1 Add the bounded capability adapters and role diagnostics
  - State: DONE.
  - Evidence (2026-10-17): alpha.2/alpha.3 positive and six unsupported-version fixtures pass; real Cordis late-install/remove/reinstall/feature-dispose test passes. Capability generation, retirement check, version check, and typecheck passed. No version bounds changed.
  - Work: add external-member/Lead capability IDs and alpha.2–alpha.3 routes, probe required methods, and follow optional Team service lifetimes.
  - Result: eligible hosts expose a stable Team interface; older/missing-service hosts retain ordinary sessions.
  - Dependencies: 0.1.
  - Read: R1, R7; design §2–3; `specs/spec005-DSH能力注册与版本路由机制/`.
  - Files: `src/dsh-capabilities/{types,matrix,routes}.ts`; proposed `src/dsh-capabilities/host/agent-team-adapter.ts`; Host service wiring; capability fixtures/tests; generated capability report via script.
  - Excludes: raising the plugin minimum, unbounded future-version support, private Team fields, and enabling the Team profile.
  - Complete when: both target versions resolve the required role interfaces, historical/rc.2/alpha.1 fixtures reject the new feature, and service removal is scoped.
  - Verify: capability/source fixtures, `pnpm run capability:report`, `pnpm run capability:check`, and typecheck.
  - Trace: R1, R7; design §2–3.

- [x] 1.2 Add session-bound bridge admission and native Team dispatch
  - State: DONE.
  - Evidence (2026-10-17): Team bridge tests cover caller spoofing, exact native Agent identity, actor replacement, disabled bridge, disposed service, Lead-only actions, task CAS errors, and the real MCP stdio shim calling the loopback endpoint. Shared legacy credentials cannot authorize Team calls; admission is checked again after reading the request body. Ordinary bridge regressions passed.
  - Work: introduce the fixed Team action contract, per-session launch credentials, exact-Agent resolution, and native operation forwarding.
  - Result: external processes can act only as their own current member; native tools use their trusted execution Agent.
  - Dependencies: 1.1.
  - Read: R1, R2, R5, R6; design §4.1, §6.2, §7.
  - Files: shared Team DTOs; `src/host/cli-bridge/bridge-server.ts` and runtime holder; proposed Team dispatcher; existing Team proxy; focused authorization tests.
  - Excludes: caller-chosen session/role, arbitrary method dispatch, weakening browser-peer or ordinary child checks, and a second task store.
  - Complete when: stale/cross-session credentials and unauthorized Lead actions fail, valid native task/message calls retain their result/error semantics, and existing dispatch stays compatible.
  - Verify: source tests for spoofing, disposal, role changes, native task CAS failures, and old endpoint regression.
  - Trace: R1, R2, R5, R6; design §2, §4.1, §6.2, §7.

- [x] 1.3 Create rostered teammates with isolated backend selection
  - State: DONE.
  - Evidence (2026-10-17): native/external Lead combinations, same-adapter concurrent different-model spawns, native model selection, rejected models/adapters, cancellation, and native provisioning failure pass real-shape fixtures. Cold stored native/external bindings retain exact identity and do not become adapter defaults. Live DSH provisioning is reserved for 3.2.
  - Work: validate adapter/model/effort, reuse the creation guard, and route native/external children through `spawnTeammate()`.
  - Result: named native members execute the intended backend without affecting sibling selections or global preferences.
  - Dependencies: 1.2.
  - Read: R3; design §5; existing continuation provider and registry code.
  - Files: `src/host/cli-adapters/native-team-subagent.ts`; Team dispatcher; registry/session binding; selection/routing tests.
  - Excludes: ordinary-child substitution, new providers, external history forks, model guessing, and global preference changes.
  - Complete when: concurrent different-model spawns remain isolated, failed provisioning stays native, and an external Lead can explicitly request a native backend.
  - Verify: real-shape fake TeamService/provider tests covering concurrency, cancellation, disabled adapters, and mixed routing.
  - Trace: R1, R3, R6; design §5.

- [x] 1.4 Expose Team tools and role-specific guidance
  - State: DONE.
  - Evidence (2026-10-17): native tool exact actor, role-specific MCP discovery/call, Claude/Codex/ACP/OpenCode launch metadata, and Command Code Mod endpoint/schema/tool-filter tests pass. Command Code exposes one local Team tool in ACP; ordinary subagent transport regressions pass.
  - Work: register the plugin Host tool and add Team discovery/calls to existing external transport injection with accurate role/name guidance.
  - Result: eligible Leads and teammates use the canonical Team route while ordinary sessions keep their current subagent contract.
  - Dependencies: 1.2, 1.3.
  - Read: R2, R7; design §4.2; existing MCP/Command Code/ACP/OpenCode injection code.
  - Files: Host tool registration; `src/host/cli-bridge/{mcp-stdio-entry,injections,command-code-mod}.ts`; participating drivers where needed; protocol fixtures.
  - Excludes: overriding official Team tools, nested delegation, private provider Teams, and tool-name guessing.
  - Complete when: reference transports expose the expected schema, teammates cannot obtain Lead authority, and unavailable bridges fail visibly without a private-provider fallback.
  - Verify: source-level discovery/call/guidance tests and ordinary subagent regression; real runtime checks remain phase 3.
  - Trace: R2, R6, R7; design §4.

## Phase 2: Complete the external collaboration loop

- [x] 2.1 Forward peer messages through active, suspended, and idle turns
  - State: DONE.
  - Evidence (2026-10-17): the stale-human-prompt defect was reproduced before the fix. Actual external LLM input now forwards ordered peer text and retains provenance. Tests pass for multiple peers/human interleaving, notices, uncertain cold input, retained iterator and driver-owned boundaries, deferred input after failure, and actual Codex peer steer. Native wake-up remains DSH-owned and requires live acceptance in 3.2.
  - Work: reproduce stale human-prompt selection, then implement provenance-aware ordered input forwarding using real driver acceptance boundaries.
  - Result: peer instructions reach the intended external participant without repeating its original task.
  - Dependencies: 1.2; 1.4 for transport integration checks.
  - Read: R4; design §6.1; `feature.ts` input extraction; segmented-turn and driver steer implementations.
  - Files: focused CLI input-selection helper; `src/host/cli-adapters/feature.ts`; affected driver boundary code; message/segmented-turn regressions.
  - Excludes: rewriting native source kinds, losing queued messages, inventing exactly-once semantics, and replaying uncertain operations.
  - Complete when: multiple peer messages, human interleaving, notices, segmentation, idle wake-up, and historical source preservation pass.
  - Verify: a failing-first relay regression, ordered multi-message fixtures, driver protocol assertions, and existing input-translation/attachment regressions.
  - Trace: R4, R6; design §6.1.

- [x] 2.2 Verify task, wait, interruption, and recovery lifecycles
  - State: DONE (source and protocol scope).
  - Evidence (2026-10-17): 13 recovery protocol tests pass across Codex, Command Code, Gemini, Grok, and MiniMax; replaced credentials resume the exact session, load failure never opens a replacement, and Team model rejection never sends a prompt. Native task errors and bounded/no-progress/teardown waits pass. Existing interruption/permission/alpha.3 admission tests are included in 3.1; live acceptance remains 3.2.
  - Work: finish native task/wait commands and prove cancellation, exact-session resume, provider failure, service teardown, and scoped driver cleanup.
  - Result: activity, inbox acceptance, task completion, and uncertain recovery remain distinguishable.
  - Dependencies: 1.3, 1.4, 2.1.
  - Read: R5–R7; design §6.2–6.3, §7; native session activation adapter and driver lifecycle tests.
  - Files: Team dispatcher/adapter; native session bridge only where required; wait/recovery/permission tests.
  - Excludes: automatic task release, new retry mailboxes, replacing missing provider sessions, and killing unrelated processes.
  - Complete when: stale revisions and unauthorized transitions retain errors, cancelled waits leave work alone, interruption is scoped, and uncertain resume is explicit.
  - Verify: deterministic fake lifecycle/permission tests, fast completion and teardown races, alpha.3 identity-preservation regression.
  - Trace: R5, R6, R7; design §6–7.

- [x] 2.3 Assess each registered adapter and integrate native presentation
  - State: DONE; Codex/Claude reference acceptance passed, other eligible transports remain source/protocol-qualified.
  - Evidence (2026-10-17): per-adapter/role matrix recorded in this Spec README and the dated development record. Catalog fixtures distinguish version, profile, installation, enablement, unsupported transport, and member-only services. Existing Agent details display localized readiness; i18n check passed with zero blocking violations. Native roster/task projections are reused unchanged.
  - Work: record collaborator/Lead tool transport and lifecycle eligibility for every registered external provider; show concise support diagnostics in existing controls.
  - Result: users see real native roster/tasks and an accurate per-adapter support matrix, with Codex/Claude as reference workflows.
  - Dependencies: 1.4, 2.1, 2.2.
  - Read: R7, R8; design §4.2, §7; adapter development and i18n rules.
  - Files: adapter support metadata and protocol fixtures; existing CLI controls/locales; a dated development record; this Spec.
  - Excludes: claiming all installed adapters work, expanding the provider allowlist, a custom task board, and modifying external applications.
  - Complete when: advertised roles have evidence, unsupported roles have reasons, and missing capabilities do not hide ordinary sessions.
  - Verify: catalog/tool/locale and projection tests; record source-tested versus live-verified status separately.
  - Trace: R7, R8; design §4.2, §7–8.

## Phase 3: Compatibility and acceptance

- [x] 3.1 Run source-based compatibility and regression checks
  - State: DONE.
  - Evidence (2026-10-17): final authorized `pnpm test` completed with 3,536 passed, 14 explicit skips, and zero failures, including the full Host/Client/H5 build. Earlier source suite passed 3,524 tests; focused affected regression passed 117; after the shared stream cleanup fix, broader driver/Team/translation regression passed 566 with nine explicit skips. Real TeamService integration passed on both temporary target installations. Typecheck, capability generation/check, version check, i18n check, script syntax, Spec links, and diff check passed. No production version bounds changed.
  - Work: exercise alpha.2/alpha.3 positive fixtures, old-version negative gates, and ordinary CLI/delegation/translation regressions.
  - Result: recorded source verification without relying on build artifacts or running applications.
  - Dependencies: 1.1–2.3.
  - Read: R1–R8; design §8; repository verification rules and `tests/register-source-loader.mjs`.
  - Files: new focused Team tests (proposed `tests/agent-team-bridge.spec.ts` and `tests/agent-team-input.spec.ts`); existing capability/native-Team/delegation/CLI tests; generated capability report through its script; this task list and dated development record.
  - Excludes: unapproved builds/servers, Desktop, and release operations. Live CLI calls belong to 3.2; final `pnpm test` was run after the explicit build authorization.
  - Complete when: relevant source tests and required static checks pass, skips/failures have explicit scope, and version metadata stays unchanged.
  - Verify: use `node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/agent-team-bridge.spec.ts tests/agent-team-input.spec.ts tests/native-team-proxy.spec.ts tests/dsh-capability-registry.spec.ts tests/dsh-capability-adapters.spec.ts tests/subagent-delegate.spec.ts tests/cli-adapters-stream.spec.ts tests/cli-adapters-turn-status.spec.ts` after creating the proposed Team test files; add directly affected driver/translation regressions. Also run typecheck, version:check, capability:check, i18n:check, and diff check.
  - Trace: R7, R8; design §8.

- [x] 3.2 Certify isolated alpha.2 and alpha.3 runtime workflows
  - State: DONE within the recorded headless reference scope.
  - Authorization (2026-10-17): user selected isolated acceptance in the native question panel, authorizing builds, temporary alpha.2/alpha.3 installations under `/tmp/codingns-spec0074-runtime-*`, their own test runtime lifetimes, and bounded Codex/Claude calls using existing logins. Existing Stage0 and Desktop remain untouched.
  - Runtime inputs: local CodingNS candidate `0.2.1-beta.13`; DSH `0.2.1-alpha.2` and `0.2.1-alpha.3`; Codex CLI `0.163.0`; Claude Code `2.1.301`; Node `22.23.3`. CLI versions were confirmed through the same driver detection used by execution.
  - Evidence: native Lead → Codex/Claude, Codex/Claude Lead → native DSH, Codex Lead → Claude, and Claude Lead → Codex passed on alpha.2 and alpha.3 (12 reference cases); Codex Lead → Codex also passed on both targets. Codex lifecycle checks passed idle wake-up, cold activation, exact provider conversation reuse, credential rotation/revocation, interruption of a running child, and preservation of existing tasks. `scripts/verify-agent-team-runtime.mjs` uses real DSH core/Team/persistence/activation and real external CLI processes; native model output is a deterministic fixture. Browser/GUI and native cloud-provider behavior are excluded, not claimed. Other adapters are source-eligible only.
  - Claude investigation: early 150-second probes timed out and one lightweight alias returned `server_error`; a text-only baseline returned `PONG`. The shared stream driver was fixed to release a process immediately after its terminal result instead of waiting for stdout EOF. Source regression verifies open-stdout completion. Final Claude reference cases passed with the existing default-model alias, low effort, only CodingNS MCP in the test process, and a bounded 600-second test budget. Saved user configuration and production Team deadlines were not changed.
  - Artifacts: `/tmp/codingns-spec0074-runtime-Bbwwaz/`; successful reports and historical failed-run logs are indexed in the dated development record. No existing Stage0 or Desktop profile/process was directly operated. Test runtime processes exited and their evidence was retained for review.
  - Work: after the applicable explicit authorization, verify the three Lead/backend combinations on both target DSH runtimes with reference external adapters.
  - Result: versioned evidence for real roster membership, tasks, peer input, wake-up, interruption, and recovery.
  - Dependencies: 3.1; isolated runtime resources; specific authorization for builds, server actions, and live calls where needed.
  - Read: R1–R8; design §8–9; `AGENTS.md` Desktop isolation rules.
  - Files: authorized Stage0 configuration only where necessary; dated acceptance record; adapter matrix; this task list.
  - Excludes: DSH Desktop operations, shared-profile replacement, automatic old-mailbox replay, unapproved process changes, and publishing.
  - Complete when: both DSH targets and all three backend combinations pass; every advertised adapter/role has the required evidence or stays unavailable.
  - Verify: record exact versions, isolated target paths, input/roster/task identities, actual results, and remaining exclusions. Fake fixtures cannot satisfy this task.
  - Trace: R1–R8; design §8–9.

- [x] 3.3 Reconcile delivery status and public documentation
  - State: DONE.
  - Evidence (2026-10-17): all 11 tasks have recorded evidence. Requirements/design/task status, version policy, per-adapter eligibility, passed reference matrix, historical failed probes, and headless limits agree. Final standard suite passed; Spec links, script syntax, whitespace, version-manifest scope, empty staging index, and changed-file scope were reviewed. Existing unrelated README edits were preserved.
  - Work: reconcile requirements, design, task evidence, compatibility claims, and the support matrix.
  - Result: a reviewable completion statement with no unsupported-version or adapter promises.
  - Dependencies: 3.1, 3.2.
  - Read: all Spec007.4 documents and recorded acceptance evidence.
  - Files: root README; this Spec; related dated development/acceptance records; earlier Spec pointers if needed.
  - Excludes: silently waiving acceptance, changing plugin version bounds, commits, tags, releases, and publication.
  - Complete when: every required task has evidence, all exclusions are explicit, and native/ordinary workflows and version promises agree.
  - Verify: requirement-to-evidence review, local links, `git diff --check`, and final working-tree scope review.
  - Trace: R1–R8; design §1–9.

## Phase 4: Session-export regressions

- [x] 4.1 Correct native child selection and external continuation after internal translation changes
  - State: DONE within the source-validation scope.
  - Evidence (2026-10-17): both supplied exports were parsed. Failing regressions reproduced inherited native effort, internal translation cancellation, and dropped settlement input for Codex/OpenCode. After the fixes, the full source suite passed 3,542 tests with 14 explicit skips and zero failures; both temporary alpha.2/alpha.3 TeamService fixtures passed. Typecheck, version/capability checks, i18n check, Spec links, and whitespace review passed. Logs: `/tmp/codingns-spec0074-session-fixes-full.log`, `/tmp/codingns-spec0074-session-fixes-focused.log`, and `/tmp/codingns-spec0074-session-fixes-i18n.log`. No build, live CLI call, application/profile/process change, commit, or release was performed for this follow-up.
  - Work: keep resolved native child model selection independent of remembered choices; retain original internal prompts on translation invalidation; forward native settlement notices without replaying the original human task.
  - Result: native provisioning and subsequent external Team steps preserve their intended model and input.
  - Dependencies: original implementation; user-supplied failure exports.
  - Files: `src/host/cli-adapters/{registry,feature,team-input}.ts`, Team dispatcher, prompt translation, shared message provenance, focused tests, and `specs/spec007.4-外部Agent团队协作与管理/docs/20261017-团队会话故障回归记录.md`.
  - Excludes: Desktop/Stage0 operation, application installation, live CLI calls, automatic recovery of old failed members/inbox items, and release actions.
  - Complete when: reproductions pass, affected source tests and static checks pass, and evidence distinguishes source fixes from live certification.
  - Verify: full source suite with `tests/register-source-loader.mjs`, temporary alpha.2/alpha.3 native libraries, typecheck, version/capability checks, and whitespace review.
  - Trace: R2, R4–R8; design §4–8.

- [x] 4.2 Enable Stage0 translation and investigate real Team/translation interactions
  - State: DONE within the recorded Stage0 alpha.3 live-validation scope.
  - Authorization (2026-10-17): user explicitly requested enabling translation in the Stage0 configuration and directly testing Teams to find conflicts. The existing Stage0 listener, supervisor, home, profile, and repository package link were confirmed before use; Desktop is excluded.
  - Configuration: Stage0 already enabled the module and bridge. Enabled the saved OpenCode translation preference and native DSH translation switch in `/Users/jackson/.dsh-stage0-020/profiles/stage0/cordis.patch.yml`; verified the effective settings through authenticated Stage0 RPC. Restarted only the confirmed Stage0 supervisor to obtain a normal launch-token connection; its configured source watcher built successfully.
  - Evidence (2026-10-17): OpenCode Lead → Codex, Codex Lead → native DSH, and Codex Lead → Codex each passed initial and follow-up rounds against real configured models. Every case returned 55, completed one task at revision 3, resumed the same reviewer for `PEER_ACK`, and retained revision 3. Final journals contain translated human input and output with zero failed translation records. The Codex-only stress case refreshed/restored translation settings and translated a human steering message alongside three Team messages in turn 1, step 2. The final authenticated inspection confirmed native/OpenCode/Codex translation enabled and bilingual display restored.
  - Fixes: mixed human/Team batches now translate only human messages and use those translations when forwarding; cancelling a human translation preserves accepted peer work. Existing internal-invalidation and settlement-delivery protections passed regression. Live tests separately exposed and fixed late native model-catalog publication and remembered effort returning after later native tool steps. Native Team routing now resolves the current catalog and retains its own model/effort selection across updates and persistence.
  - Source verification: final full source suite passed 3,547 tests, with 14 explicit skips and zero failures; final focused suite passed 174 without skips/failures. Typecheck, version/capability checks, verifier syntax, Spec links, and whitespace checks passed. Logs: `/tmp/codingns-spec0074-stage0-final-source.log` and `/tmp/codingns-spec0074-stage0-final-focused.log`.
  - Live artifacts: final `report.json`, two Lead journals, and supplemental `journal-evidence.json` are retained under `/var/folders/q5/5jq71t9d131d8p_8l01rth400000gn/T/codingns-spec0074-stage0-team-27RnHi/` (Codex/native), `codingns-spec0074-stage0-team-zjCNrW/` (Codex/Codex stress), and `codingns-spec0074-stage0-team-Jb6FK0/` (OpenCode/Codex). Effective final settings are recorded privately in `/tmp/codingns-spec0074-stage0-restored-config.json`. Detailed outcomes and historical failed probes are recorded in `specs/spec007.4-外部Agent团队协作与管理/docs/20261017-会话翻译与团队协作联调记录.md`.
  - Final state: Stage0 remains running with translation enabled; the live test turns and reviewers have completed. No Desktop operation, release, implementation commit, push, or publication occurred. The original isolated acceptance and task 4.1 boundaries below describe their earlier checkpoints, not this later Stage0 authorization.
  - Work: use real configured translation models and external CLIs, exercise initial and follow-up Team turns, reproduce and fix conflicts, and record both successful and failed runs.
  - Files: Stage0-only configuration, `scripts/verify-stage0-team-translation.mjs`, affected source/tests, and this Spec.
  - Excludes: Desktop, unrelated sessions, authentication changes, deletion of historical data, and publishing.
  - Complete when: effective Stage0 translation is enabled; tested conflicts have concrete evidence and regressions; final live outcomes and remaining limitations are recorded.
  - Verify: authenticated Stage0 RPC, native roster/task projections, persisted session/translation records, bounded live calls, targeted source tests, typecheck, and compatibility checks.
  - Trace: R2, R4–R8; design §4–8.

- [x] 4.3 Correct Grok Team coordination admission under inherited approval policy
  - State: DONE within the recorded source and Stage0 alpha.3 collaborator scope.
  - Evidence: read all 105 records from the supplied `dsh-session-12484a82-25c7-4dfb-b92a-779cbc927c4e.zip`. Both turns used the real `codingns-cli-grok` / `grok-4.7-build-fast` route and discovered `codingns__agent_team`. Each failed when the native `workspace-write` / `never` policy automatically rejected the Grok permission request for the Team tool; sibling tool results became unconfirmed and queued Team input remained undelivered. The inherited Codex label in the creation descriptor is not the execution route.
  - Verification (2026-10-17): the new replay failed before the source correction and passes afterward across two turns. The focused Grok permission/lifecycle and Team bridge/recovery suite passed 75 tests without skips/failures. The final full source suite passed 3,561 tests, with 15 explicit skips and zero failures; the additional alpha.2 library skip was resolved in a separate two-version native TeamService run, which passed both tests using the existing isolated installations. Typecheck, version synchronization, capability retirement, verifier syntax, Spec links, whitespace, and empty-staging/version-manifest scope checks passed. Logs: `/tmp/codingns-spec0074-grok-permission-before.log`, `/tmp/codingns-spec0074-grok-focused.log`, `/tmp/codingns-spec0074-grok-full-source.log`, and `/tmp/codingns-spec0074-grok-native-versions.log`.
  - Live evidence: a fresh Stage0 Codex → Grok case passed initial/follow-up rounds with the same Grok Build 1.0.62 reviewer, actual `grok-4.7-build-fast` routing, inherited `workspace-write` / `never`, zero native approval requests, result 55, `PEER_ACK`, and task revision 3 preserved. Both reviewer turns completed. Lead `session-bf5a4baa-fce3-44b3-afd3-dc2c7868dc21`, reviewer `788ddd56-d69a-466e-a787-de328b405a54`; report, complete Grok journal, both Lead journals, and `live-evidence.json` are retained in `/var/folders/q5/5jq71t9d131d8p_8l01rth400000gn/T/codingns-spec0074-stage0-team-CIJKAP/`. The live log is `/tmp/codingns-spec0074-grok-stage0-live.log`. Final saved settings match their pre-test values, including the user's current Codex translation preference of false.
  - Final scope: source watcher compiled successfully; the existing Stage0 remains running, and the test turns completed. Grok Lead and alpha.2 live CLI acceptance remain unclaimed. The old failed session was retained without automatic replay. Detailed evidence is recorded in `specs/spec007.4-外部Agent团队协作与管理/docs/20261017-Grok队友权限故障回归记录.md`. No Desktop operation, implementation commit, release, push, or publication occurred.
  - Work: reproduce the exact bound-Team permission request and permit only the injected coordination tool within its existing write authority, preserving unrelated permissions, one-time option selection, and launch-scoped identity.
  - Files: Grok driver, focused permission/Team regressions, and this Spec.
  - Excludes: changing saved approval/sandbox policy, enabling blanket Grok approval, Desktop operations, retrying the old rejected session, and release actions.
  - Complete when: the reproduction passes across follow-up turns, unrelated/risky/unbound requests retain native approval handling, and verification limits are recorded.
  - Verify: failing-first Grok replay, affected source tests, typecheck, version/capability checks, and whitespace/document checks.
  - Trace: R2, R4–R8; design §4–8.

## Planning verification (2026-10-17)

Only documentation was created or updated. Source code, version manifests, runtime configuration, applications, and the Git index were unchanged. The initial checks covered local links, task completeness, and whitespace; implementation tests were not run for this documentation-only change.

## Delivery verification (2026-10-17)

The planning-only checkpoint above is historical. The plan was subsequently committed as `10bd749`, followed by authorized source development and isolated acceptance.

Claude follow-up resolved: a plain default-model baseline returned `PONG`; the standard stream driver was fixed to settle a terminal result without waiting for stdout EOF. Its open-stdout regression passed, followed by 566 successful driver/Team/translation regressions (nine explicit skips) and all eight Claude reference cases across both targets.

- Full source result: `/tmp/codingns-spec0074-source-tests.log` — 3,524 passed, 14 skipped, zero failures.
- Final affected result: `/tmp/codingns-spec0074-delivery-source.log` — 117 passed, no skips/failures; both target native TeamService libraries were exercised.
- Final standard result: `/tmp/codingns-spec0074-standard-test.log` — 3,536 passed, 14 skipped, zero failures; full build included. Build/typecheck evidence also exists in `/tmp/codingns-spec0074-delivery-build.log` and `/tmp/codingns-spec0074-final-final-typecheck.log`. Capability/version/localization checks passed; localization reported zero blocking violations and 200 existing internal-log/error warnings.
- Live reports/logs: `/tmp/codingns-spec0074-runtime-Bbwwaz/`, indexed in `docs/开发记录/20261017-外部Agent团队协作与管理开发记录.md`. All 12 native/external and mixed Codex/Claude reference cases passed, with two additional Codex-only external-Team cases and lifecycle checks on both targets. Historical failed probes remain evidence of the investigation, not outstanding certification failures.
- Source/doc scope was reviewed, Spec links resolved, script syntax and `git diff --check` passed. Version manifests and plugin-wide compatibility bounds were unchanged. Existing unrelated README edits were preserved.
- The implementation is not committed, pushed, tagged, released, or published. Existing Stage0 and Desktop were not directly operated; temporary test resources were closed and evidence retained. All Spec007.4 implementation tasks are complete within the stated validation scope.

The delivery checkpoint above predates the user's explicit Stage0 follow-up. Task 4.2 records the later authorized Stage0 configuration changes, cold-start/live tests, final 3,547-test source result, and retained running Stage0 instance. Desktop remained untouched throughout.
