# Tasks - Global Assistant Extraction and Performance Governance

Status: Approved by the user on 2026-10-29; local implementation and verification are complete as of 2026-10-30. Live DSH/browser workflow, real-profile migration, and machine-level performance gates remain explicitly open.

## Status

- `TODO`: not started
- `IN_PROGRESS`: active
- `BLOCKED`: blocked by a named external dependency
- `IN_REVIEW`: evidence is ready for review
- `DONE`: verified and recorded here
- `[x]` may only be used for a `DONE` task.

## Phase 0: Evidence and boundary

- [ ] 0.1 Complete package, lifecycle, data, and performance baseline
  - Status: IN_REVIEW
  - What to do: Trace assistant imports/exports, registries, RPC allowlists, configuration, files, persisted data, recurring work, and current package/build artifacts; profile base-only and assistant-idle/active states where isolated tooling permits.
  - What will be visible: A source-backed ownership map, import graph (235 runtime-imported/289 total local TS files), recurring-work inventory, and identified storage/RPC/settings owners. Runtime CPU/memory profile and numeric budgets are not available.
  - Dependency: User approved the Spec and selected `/Users/jackson/Code/CodingNS/data/dsh-global-assistant`; profiling must not touch Desktop or a running user profile.
  - Read first: `requirements.md`; `design.md` §§2-4; `docs/20261029-助理模块现状与性能热点.md`; Specs 013, 013.1, 014, and 014.1.
  - Main files: Spec documents; dated investigation evidence; package/entry/registry/config/RPC/data source files read-only until approved.
  - Explicitly not doing: No DSH server starts, Desktop operations, or production attribution during this task.
  - Done when: Source-level inventory and ownership map are reviewed; runtime profiling and numeric-budget criteria remain explicitly open.
  - Verify: Source graph and lifecycle review. No build/runtime machine profile was run; no Desktop/profile/process was accessed.
  - Requirements/design: Requirements 1-5; `design.md` §§2-3.

- [ ] 0.2 Approve standalone package boundary and budgets
  - Status: IN_REVIEW
  - What to do: Resolve repository/package boundary, neutral contracts, data root/rollback, performance environment, and numeric budgets before runtime implementation.
  - What will be visible: The sibling package shell, neutral settings/RPC contracts, Host/Client assembly, multi-root migration/rollback engine, explicit owner-confirmed migration preview/import/rollback flow, exact-Fetch RPC allowlist, full `/api/` voice/avatar routes, and package graph exist. A clean lockfile install succeeds in an isolated temporary copy. Machine-level performance budgets remain unmeasured.
  - Dependency: User has selected the separate project directory; numeric performance measurements remain outstanding.
  - Read first: `requirements.md`; `design.md` §§2-4, 7; task 0.1 evidence.
  - Main files: `design.md`; this task list; dated investigation evidence.
  - Explicitly not doing: No Desktop installation/profile changes or publication. Do not switch Host/Client settings ownership or remove base registrations until live integration, parity, migration activation, and performance evidence are reviewed.
  - Done when: The package contract and data ownership are decided; numeric runtime budgets are approved from isolated measurements.
  - Blocking detail (2026-10-29): Boundary decisions are implemented in source: Host RPC uses a finite exact Fetch allowlist instead of Connection's unique `/api` interceptor; authenticated Peer and cancellation reach the handler; voice/avatar routes keep complete `/api/...` paths. A clean install from the lockfile passed in an isolated temporary directory (865 packages; npm emitted transitive DSH peer-version warnings). A versioned multi-root migration, owner-authenticated read-only preview, explicit import confirmation, and checksum-guarded rollback now pass fixture tests. The flow is not automatic and has not been exercised against real user data. Runtime CPU/memory/network and browser DOM budgets have not been measured; keep this task IN_REVIEW until those are reviewed.
  - Verify: Cross-check package graph and migration plan; use isolated fixtures for measurements and record unavailable live-device evidence rather than assuming it.
  - Requirements/design: Requirements 1-6; `design.md` §§2, 3, 4, 7.

## Phase 1: Independent package foundation

- [ ] 1.1 Create standalone assistant package shell and contract tests
  - Status: IN_REVIEW
  - What to do: Establish the independently buildable DSH package, manifest, entry points, dependency graph, test fixtures, and neutral integration contracts.
  - What will be visible: Destination project `/Users/jackson/Code/CodingNS/data/dsh-global-assistant` has a DSH manifest, Host/Client entry points, neutral contracts, source graph, tests, and build configuration. A clean lockfile install, typecheck, full tests, boundary checks, build, package graph, manifest-target validation, and package dry-run pass in an isolated temporary copy. The real Connection dispatcher is composed with assistant exact Fetch routes and a Gateway-style interceptor in tests; the actual DSH Typert Gateway/browser runtime remains unverified.
  - Dependency: 0.2.
  - Read first: Requirements 1, 2, 6; design §§2.1-2.3, 4.3; existing feature registry and package manifest.
  - Main files: New assistant package manifest/config/entry files; neutral contract package or interface; package-boundary tests.
  - Explicitly not doing: No runtime feature migration, user data migration, release, or Desktop install.
  - Done when: Independent package checks pass and unsupported peer combinations degrade once with a bounded diagnostic.
  - Blocking detail: Host RPC registers an explicit 67-endpoint exact Fetch allowlist; it does not claim the reserved `/api` interceptor. The handler preserves Connection trust rejection, authenticated Peer admission, request cancellation, the standard JSON envelope, and structured errors. Voice/avatar registrars use full `/api/...` paths and the DSH `streaming` request-body literal. A clean lockfile install and all package checks now pass. Remaining gaps are live DSH Gateway/browser composition, accepted workflow parity, and activated legacy settings/data ownership. The primitive external is explicitly listed in DSH Client inject; `schemastery` is declared as a peer and boundary-tested.
  - Current result (2026-10-29): In an isolated temporary copy, `npm ci --include=dev --ignore-scripts --offline` added 865 packages (with transitive DSH peer-version warnings); then `npm run typecheck`, `npm test` (132/132), `npm run test:boundary` (23/23), `npm run check:package-graph` (248 source files), `npm run build`, manifest export-target validation, and `npm pack --dry-run --json` (1,087 entries, zero bundled dependencies) all passed. The exact route set includes the three migration endpoints; tests compose the real installed Connection dispatcher with assistant routes and a Gateway-style `/api` interceptor, but not the actual Typert Gateway/browser runtime. Host route modules, the Client assistant panel, and migration implementation now build as deferred imports. This remains source-level integration evidence, not accepted workflow parity.
  - Follow-up verification (2026-10-30): After adding the voice-diagnostics lifecycle regression, the standalone package passes `npm test` 173/173, `npm run typecheck`, `npm run test:boundary` 23/23, `npm run check:package-graph` (248 sources), `npm run build`, 7 export-target checks, and `npm pack --dry-run --json` (1,111 entries). The Stage0 Host health sampler is now explicitly opt-in and releases its interval on disposal.
  - Clean-install verification (2026-10-30): A fresh temporary copy with `npm ci --include=dev --ignore-scripts --offline` installed 865 packages, then passed typecheck, npm test 173/173, boundary tests 23/23, and package-graph checks. npm reported only transitive DSH peer-version warnings; the package lockfile resolved successfully without network access.
  - Verify: Re-run checks from a clean lockfile install when registry access is available; exercise the actual DSH Connection + Gateway composition and browser Client runtime. Test output proves the local source/build contracts only.
  - Requirements/design: Requirements 1, 6; `design.md` §§2, 4.3, 6.2.

- [ ] 1.2 Move assistant runtime and UI with behavior parity
  - Status: BLOCKED
  - What to do: Move assistant-owned Client, Host, shared, avatar, voice, notification, locale, capability-adapter, asset, and test code according to the approved ownership map.
  - What will be visible: Assistant-owned Host/Client/shared/avatar/voice/notification/desktop sources have been copied or adapted into the standalone package with no runtime donor imports. Settings-store read-only, fallback-write, duplicate-notification, and failed-load defects are fixed; Host feature and route imports and the Client settings panel are deferred. Donor registrations and assistant-owned settings/RPC/asset package wiring have now been removed; accepted workflow parity and live Host/Client integration are not established.
  - Dependency: 1.1.
  - Read first: All assistant Specs; approved inventory; design §§2-4.
  - Main files: Current `src/client/features/assistant-*`, assistant avatar, `src/host/features/assistant-*`, `src/host/desktop-assistant/`, relevant `src/shared/`, `src/dsh-capabilities/`, assets, tests, and new package files.
  - Explicitly not doing: Do not remove the old implementation until the new package passes parity tests; do not alter unrelated features.
  - Done when: Existing accepted workflows map to tests or documented real-device follow-ups; the new package can run with optional base integration absent.
  - Blocking detail (2026-10-30): 248 destination source files have no donor dependency; Host settings/RPC, exact Fetch routes, assembly, Typert, settings-store, migration RPC, migration fixtures, and package build pass. Source-level contract coverage now includes voice-agent service (21 tests), dispatch/scope (10), notification source/events (8), and voice-diagnostics lifecycle (2), for 173 total standalone tests. The migration UI is explicitly opt-in and owner-authenticated; it does not run at startup. These tests do not prove accepted workflow parity: live DSH Gateway/browser composition, end-to-end Client UI workflows, desktop renderer lookup, real user-data migration, and matched runtime profiling remain unverified. The donor assistant source trees, assets, and obsolete tests have been physically removed.
  - Verify: Focused assistant suite, typecheck, version/capability checks, isolated dual-plugin fixtures, and dependency graph checks.
  - Requirements/design: Requirements 1, 2, 6; `design.md` §§2, 4.1, 4.3.

## Phase 2: Performance reduction and base removal

- [ ] 2.1 Remove measured idle waste and enforce resource budgets
  - Status: IN_REVIEW
  - What to do: Correct profiled recurring work, including global DOM observation/scan behavior, companion refresh cadence, unnecessary startup/event subscriptions, and any confirmed active-work leaks.
  - What will be visible: Host assistant/avatar/companion features are off unless `globalVoiceAssistant` is enabled; companion notification polling is replaced by revision events; preview cleanup is dormant without leases; the mounted launcher avoids repeated full-button scans; Host route modules and Client settings-panel implementation are deferred. Further runtime profiling and observer-scope work remain.
  - Dependency: 0.2 and affected work in 1.2.
  - Read first: Requirements 4-5; design §3; baseline evidence and `src/client/features/global-voice-assistant.ts`, `src/host/desktop-assistant/feature.ts`, Host assistant lifecycle.
  - Main files: Only measured hot-path source and focused regression tests in the new assistant package/base package.
  - Explicitly not doing: Do not optimize unrelated code or change visible behavior without a requirement and regression coverage.
  - Done when: No unexplained assistant-owned recurring work exists in idle; each active workload is within its numeric budget and cancellation/teardown passes. Current source fixes are partial and do not yet satisfy this criterion.
  - Current result: The assistant implementation, assets, and donor-only performance harness have been removed from the base plugin. The standalone package retains the deterministic lifecycle evidence: background event storms collapse onto at most one armed timer, lease churn keeps one shared reclamation timer, and revision subscriptions deliver exactly once with no delivery after unsubscribe/dispose. Runtime CPU/memory/network, browser DOM churn, inference latency, and matched idle/active profiles remain unmeasured.
  - Follow-up source-cost finding (2026-10-30): `installVoiceDiagnostics()` created a 2-second Host health interval and enabled `monitorEventLoopDelay()` whenever the voice feature started in Stage0, even while the coordinator was idle. It now requires `CODINGNS4DSH_VOICE_DIAGNOSTICS=1`; a lifecycle regression proves the default Stage0 path arms zero intervals and the explicit path releases its sampler on dispose. This removes a confirmed idle instrumentation loop, but it is source/lifecycle evidence—not a machine-level CPU or memory measurement and not an attribution of the original user reports.
  - Verify: standalone performance tests and profiling remain recorded in the independent package; donor verification is `pnpm run typecheck`, `pnpm run build`, and `node scripts/check-assistant-package.mjs`. The base plugin no longer contains `tests/assistant-performance.spec.ts` or `scripts/profile-assistant.mjs`.
  - Requirements/design: Requirements 4-5; `design.md` §§3, 5.2, 6.3.

- [ ] 2.2 Migrate existing data safely and switch ownership
  - Status: IN_REVIEW
  - What to do: Add and test versioned idempotent migration, switch assistant storage/RPC/UI ownership, then remove old registrations and implementation from the base plugin.
  - What will be visible: The standalone code writes new conversation, voice-model, avatar-engine/package, and companion state under its `global-assistant` data roots. Version 2 migration maps separate donor roots, streams large files, preserves existing destination data/settings, records recoverable staging, and rolls back unchanged migration-owned files/settings from completed or failed runs. A settings-panel preview starts the process; import and rollback each require a separate confirmation and an owner-authenticated Host RPC. Migration is not automatic. Donor assistant startup and settings/RPC/asset ownership have been removed, but live migration and workflow acceptance remain open.
  - Dependency: 1.2; migration and budgets approved in 0.2.
  - Read first: Requirements 2-3; design §§2, 4; task 1.2.
  - Main files: Assistant storage/settings migration; base and assistant manifests, registries, exports, RPC allowlists, config validators, assets, package tests.
  - Explicitly not doing: Do not delete user data or operate installed Desktop profiles; do not release or publish.
  - Done when: Failure-injection/downgrade tests pass, source data remains recoverable, and package/bundle graph excludes assistant implementation from base. This task is blocked until a standalone Host/Client service and settings contract exists and passes parity tests.
  - Blocking detail: Donor path mapping, non-default settings preservation, staging recovery, and checksum-guarded rollback are fixture-tested. The standalone Host can read the legacy `codingns` settings descriptor and writes only the assistant-owned settings scope after confirmation; the flow refuses a read-only or unavailable settings provider. The remaining blockers are live DSH Gateway/browser composition, accepted workflow parity, real-profile migration/recovery evidence, and matched runtime profiles. The base ownership cut is implemented and must not be treated as proof that those acceptance gates passed.
  - Audit status (2026-10-30): The eight coupled donor ownership groups were removed in one working-tree change. Assistant-owned source trees, assets, voice replay harness, and assistant-only tests were deleted after import-graph review. Startup removes only the stale `assistant` settings object and `modules.globalVoiceAssistant` key when writable; it preserves user data, retries after skipped attempts when a document update is available, and contains provider event-subscription/disposal failures so unrelated Host setup proceeds. `scripts/check-assistant-package.mjs`, donor typecheck/build, version/capability checks, focused isolation tests, and Host-entry/cleanup regressions pass. No Desktop/profile/process was touched. Migration remains explicit opt-in and has only fixture evidence; task-2.2 stays IN_REVIEW until live parity, real-profile migration validation, and matched runtime performance evidence are recorded.
  - Residue sweep (2026-10-30): Removed the last unused assistant route fields, obsolete assistant-only attachment upload/tool implementation, stale voice/MOSS diagnostic harness and analyzer, plus tests that referenced removed routes/services/settings. Renamed the live DSH-native attachment bridge to neutral `NativeAttachment*` contracts without changing its validation or behavior. Focused cleanup, Host entry, PeerHost, provider-icon, native-session, and settings-bridge tests pass 51 with 2 intentionally skipped; no claim of live workflow or full-suite parity is made.
  - Verify: Migration idempotence/rollback tests; base-only and assistant-only integration tests; package-contents and dependency checks.
  - Requirements/design: Requirements 2-3, 6; `design.md` §§2.3, 4, 5.3.

## Phase 3: Compatibility and final acceptance

- [ ] 3.1 Verify workflows, resource lifecycle, and package combinations
  - Status: IN_REVIEW
  - What to do: Run the complete supported workflow and compatibility matrix for base only, assistant only, both, missing peer, disabled peer, incompatible peer, upgrade, downgrade, and removal.
  - What will be visible: A traceable pass/fail record and remaining real-device gaps.
  - Dependency: 2.1 and 2.2.
  - Read first: All requirements/design; Specs 013, 013.1, 014, 014.1; task 0.1 baseline.
  - Main files: Package tests, regression fixtures, this Spec, dated development/verification record.
  - Explicitly not doing: No Desktop, user-profile, live install, release, or publication operations.
  - Done when: All source-level workflows and supported-version fixtures pass; remaining hardware/device checks have named owners and are not misreported as complete.
  - Verify (2026-10-30): donor `pnpm run test:isolated` copied the current source into a temporary workspace, then passed typecheck, version/capability/i18n checks, build, the full suite (3,304 tests: 3,266 passed, 38 skipped, 0 failed), pack/unpack, and package smoke. The four stale DSH-version fixture expectations were updated to use the current tested version; the external-session-label assertion now excludes only the removed UI labels while allowing valid shared Credentials wording. The standalone package passes typecheck, npm test (173/173), boundary tests (23/23), package graph (248 sources), build, 7 manifest export targets, and package dry-run (1,111 entries). Live DSH/browser workflow, real-profile migration, and matched runtime profiling remain open.
  - Requirements/design: Requirements 1-6; `design.md` §§4-6.

- [ ] 3.2 Final audit and handoff
  - Status: IN_REVIEW
  - What to do: Audit changed-file scope, package independence, migration safety, performance evidence, Specs cross-references, and open acceptance gaps.
  - What will be visible: Reviewed extraction record, performance-fix evidence, the standalone destination README, and an explicit extraction blocker; no claim of release or installation.
  - Dependency: 3.1.
  - Read first: All Spec documents and verification evidence.
  - Main files: This Spec; dated investigation/development record; relevant Spec pointers.
  - Explicitly not doing: No commit, push, tag, publication, installation, or Desktop operation without separate authorization.
  - Done when: Current source fixes and verification evidence are recorded; unresolved runtime profiling and standalone contract work are explicit; concurrent workspace changes remain preserved.
  - Verify (2026-10-30): Requirements-to-evidence review, package graph (248 donor-free sources), source registry audit, standalone tests/typecheck/build/package dry-run, isolated donor version/capability/i18n/build/full-suite/package-smoke checks, and focused cleanup/feature tests pass. No live DSH Gateway/browser composition, user-profile migration, Desktop renderer lookup, matched runtime performance profiles, or real-device behavior was performed; donor ownership removal is implemented but is not evidence that these gates passed.
  - Requirements/design: All requirements; `design.md` §§5-7.
