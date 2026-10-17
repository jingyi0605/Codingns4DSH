# Tasks: External Agent Team collaboration and management

Status: Plan checked and accepted for implementation on 2026-10-17. Development follows the planning submission.

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

- [ ] 1.1 Add the bounded capability adapters and role diagnostics
  - State: TODO.
  - Work: add external-member/Lead capability IDs and alpha.2–alpha.3 routes, probe required methods, and follow optional Team service lifetimes.
  - Result: eligible hosts expose a stable Team interface; older/missing-service hosts retain ordinary sessions.
  - Dependencies: 0.1.
  - Read: R1, R7; design §2–3; `specs/spec005-DSH能力注册与版本路由机制/`.
  - Files: `src/dsh-capabilities/{types,matrix,routes}.ts`; proposed `src/dsh-capabilities/host/agent-team-adapter.ts`; Host service wiring; capability fixtures/tests; generated capability report via script.
  - Excludes: raising the plugin minimum, unbounded future-version support, private Team fields, and enabling the Team profile.
  - Complete when: both target versions resolve the required role interfaces, historical/rc.2/alpha.1 fixtures reject the new feature, and service removal is scoped.
  - Verify: capability/source fixtures, `pnpm run capability:report`, `pnpm run capability:check`, and typecheck.
  - Trace: R1, R7; design §2–3.

- [ ] 1.2 Add session-bound bridge admission and native Team dispatch
  - State: TODO.
  - Work: introduce the fixed Team action contract, per-session launch credentials, exact-Agent resolution, and native operation forwarding.
  - Result: external processes can act only as their own current member; native tools use their trusted execution Agent.
  - Dependencies: 1.1.
  - Read: R1, R2, R5, R6; design §4.1, §6.2, §7.
  - Files: shared Team DTOs; `src/host/cli-bridge/bridge-server.ts` and runtime holder; proposed Team dispatcher; existing Team proxy; focused authorization tests.
  - Excludes: caller-chosen session/role, arbitrary method dispatch, weakening browser-peer or ordinary child checks, and a second task store.
  - Complete when: stale/cross-session credentials and unauthorized Lead actions fail, valid native task/message calls retain their result/error semantics, and existing dispatch stays compatible.
  - Verify: source tests for spoofing, disposal, role changes, native task CAS failures, and old endpoint regression.
  - Trace: R1, R2, R5, R6; design §2, §4.1, §6.2, §7.

- [ ] 1.3 Create rostered teammates with isolated backend selection
  - State: TODO.
  - Work: validate adapter/model/effort, reuse the creation guard, and route native/external children through `spawnTeammate()`.
  - Result: named native members execute the intended backend without affecting sibling selections or global preferences.
  - Dependencies: 1.2.
  - Read: R3; design §5; existing continuation provider and registry code.
  - Files: `src/host/cli-adapters/native-team-subagent.ts`; Team dispatcher; registry/session binding; selection/routing tests.
  - Excludes: ordinary-child substitution, new providers, external history forks, model guessing, and global preference changes.
  - Complete when: concurrent different-model spawns remain isolated, failed provisioning stays native, and an external Lead can explicitly request a native backend.
  - Verify: real-shape fake TeamService/provider tests covering concurrency, cancellation, disabled adapters, and mixed routing.
  - Trace: R1, R3, R6; design §5.

- [ ] 1.4 Expose Team tools and role-specific guidance
  - State: TODO.
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

- [ ] 2.1 Forward peer messages through active, suspended, and idle turns
  - State: TODO.
  - Work: reproduce stale human-prompt selection, then implement provenance-aware ordered input forwarding using real driver acceptance boundaries.
  - Result: peer instructions reach the intended external participant without repeating its original task.
  - Dependencies: 1.2; 1.4 for transport integration checks.
  - Read: R4; design §6.1; `feature.ts` input extraction; segmented-turn and driver steer implementations.
  - Files: focused CLI input-selection helper; `src/host/cli-adapters/feature.ts`; affected driver boundary code; message/segmented-turn regressions.
  - Excludes: rewriting native source kinds, losing queued messages, inventing exactly-once semantics, and replaying uncertain operations.
  - Complete when: multiple peer messages, human interleaving, notices, segmentation, idle wake-up, and historical source preservation pass.
  - Verify: a failing-first relay regression, ordered multi-message fixtures, driver protocol assertions, and existing input-translation/attachment regressions.
  - Trace: R4, R6; design §6.1.

- [ ] 2.2 Verify task, wait, interruption, and recovery lifecycles
  - State: TODO.
  - Work: finish native task/wait commands and prove cancellation, exact-session resume, provider failure, service teardown, and scoped driver cleanup.
  - Result: activity, inbox acceptance, task completion, and uncertain recovery remain distinguishable.
  - Dependencies: 1.3, 1.4, 2.1.
  - Read: R5–R7; design §6.2–6.3, §7; native session activation adapter and driver lifecycle tests.
  - Files: Team dispatcher/adapter; native session bridge only where required; wait/recovery/permission tests.
  - Excludes: automatic task release, new retry mailboxes, replacing missing provider sessions, and killing unrelated processes.
  - Complete when: stale revisions and unauthorized transitions retain errors, cancelled waits leave work alone, interruption is scoped, and uncertain resume is explicit.
  - Verify: deterministic fake lifecycle/permission tests, fast completion and teardown races, alpha.3 identity-preservation regression.
  - Trace: R5, R6, R7; design §6–7.

- [ ] 2.3 Assess each registered adapter and integrate native presentation
  - State: TODO.
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

- [ ] 3.1 Run source-based compatibility and regression checks
  - State: TODO.
  - Work: exercise alpha.2/alpha.3 positive fixtures, old-version negative gates, and ordinary CLI/delegation/translation regressions.
  - Result: recorded source verification without relying on build artifacts or running applications.
  - Dependencies: 1.1–2.3.
  - Read: R1–R8; design §8; repository verification rules and `tests/register-source-loader.mjs`.
  - Files: new focused Team tests (proposed `tests/agent-team-bridge.spec.ts` and `tests/agent-team-input.spec.ts`); existing capability/native-Team/delegation/CLI tests; generated capability report through its script; this task list and dated development record.
  - Excludes: building through `pnpm test`, servers, live CLI calls, Desktop, and release operations.
  - Complete when: relevant source tests and required static checks pass, skips/failures have explicit scope, and version metadata stays unchanged.
  - Verify: use `node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/agent-team-bridge.spec.ts tests/agent-team-input.spec.ts tests/native-team-proxy.spec.ts tests/dsh-capability-registry.spec.ts tests/dsh-capability-adapters.spec.ts tests/subagent-delegate.spec.ts tests/cli-adapters-stream.spec.ts tests/cli-adapters-turn-status.spec.ts` after creating the proposed Team test files; add directly affected driver/translation regressions. Also run typecheck, version:check, capability:check, i18n:check, and diff check.
  - Trace: R7, R8; design §8.

- [ ] 3.2 Certify isolated alpha.2 and alpha.3 runtime workflows
  - State: TODO; runtime actions have not been authorized by this planning request.
  - Work: after the applicable explicit authorization, verify the three Lead/backend combinations on both target DSH runtimes with reference external adapters.
  - Result: versioned evidence for real roster membership, tasks, peer input, wake-up, interruption, and recovery.
  - Dependencies: 3.1; isolated runtime resources; specific authorization for builds, server actions, and live calls where needed.
  - Read: R1–R8; design §8–9; `AGENTS.md` Desktop isolation rules.
  - Files: authorized Stage0 configuration only where necessary; dated acceptance record; adapter matrix; this task list.
  - Excludes: DSH Desktop operations, shared-profile replacement, automatic old-mailbox replay, unapproved process changes, and publishing.
  - Complete when: both DSH targets and all three backend combinations pass; every advertised adapter/role has the required evidence or stays unavailable.
  - Verify: record exact versions, isolated target paths, input/roster/task identities, actual results, and remaining exclusions. Fake fixtures cannot satisfy this task.
  - Trace: R1–R8; design §8–9.

- [ ] 3.3 Reconcile delivery status and public documentation
  - State: TODO.
  - Work: reconcile requirements, design, task evidence, compatibility claims, and the support matrix.
  - Result: a reviewable completion statement with no unsupported-version or adapter promises.
  - Dependencies: 3.1, 3.2.
  - Read: all Spec007.4 documents and recorded acceptance evidence.
  - Files: root README; this Spec; related dated development/acceptance records; earlier Spec pointers if needed.
  - Excludes: silently waiving acceptance, changing plugin version bounds, commits, tags, releases, and publication.
  - Complete when: every required task has evidence, all exclusions are explicit, and native/ordinary workflows and version promises agree.
  - Verify: requirement-to-evidence review, local links, `git diff --check`, and final working-tree scope review.
  - Trace: R1–R8; design §1–9.

## Planning verification (2026-10-17)

Only documentation was created or updated. Source code, version manifests, runtime configuration, applications, and the Git index were unchanged. The initial checks covered local links, task completeness, and whitespace; implementation tests were not run for this documentation-only change.
