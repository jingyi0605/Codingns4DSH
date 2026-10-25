# Task List - Codingns4DSH Plugin Updates and No-Desktop-Restart Activation

Status: The layout correction passed 65 isolated focused cases and build/package checks. The last full compiled run, before this correction, had 4,006 passes, one pre-existing failure, and 29 skips. Desktop Client replacement and final Spec acceptance remain blocked by the missing upstream contract.

## Purpose

This task list records the implementation order for Spec001.1. It deliberately separates metadata, package mutation, and live activation so that a successful npm installation is not mistaken for a running update.

## Status values

- `TODO`: not started
- `IN_PROGRESS`: currently being implemented
- `BLOCKED`: blocked by an external condition; the blocker must be named
- `IN_REVIEW`: implementation exists and awaits verification
- `DONE`: completed and verified
- `CANCELLED`: explicitly not implemented, with a reason

Only tasks with `Status: DONE` may be checked off.

## Implementation evidence (2026-10-25)

- `tests/plugin-update.spec.ts` covers metadata, tags, compatibility, manager normalization, capability fixtures, owner/local authorization, operation serialization, cancellation, activation truth tables, Client state, and settings confirmation.
- `tests/plugin-update-browser.spec.ts` covers real Chromium/HTTP settings acceptance with fixture metadata and manager outcomes, including confirmation, recovery, cancellation, offline retention, mobile layout, and unsupported Desktop reporting.
- `scripts/test-isolated.mjs` provides disposable build, compiled-test, browser, and tarball verification without using a real DSH profile.
- Shared contract: `src/shared/contracts/plugin-update.ts`.
- Host implementation: `src/host/update/`, `src/host/features/plugin-update.ts`.
- Client implementation: `src/client/settings-update.ts`, `src/client/update-store.ts`, `src/client/update-panel.ts`, and the presentation-only `src/client/settings-promo.ts`. The internal Client feature has no settings-card UI.
- Release contract and limitations: `docs/调查报告/20261025-插件更新接口与实现边界.md`.
- Verification details: `docs/开发记录/20261025-Spec001.1插件更新开发记录.md`.
- The package-manager route is pinned to DSH 0.2.1-rc.2. It rejects HMR self-replacement and Desktop/unknown profiles. A future release needs new verified capability evidence.
- The production Client reload capability is unavailable. No task marked DONE here establishes live Desktop activation.

## Phase 0: Establish the Spec and evidence

- [x] 0.1 Create the Spec documents
  - Status: DONE
  - What this does: Create the README, requirements, design, task list, and supplementary-doc index for the updater scope.
  - What becomes visible: The package-update, release-note, package-manager, and activation boundaries are explicit.
  - Dependencies: None.
  - Read first:
    - `AGENTS.md`
    - `specs/000-Spec规范/Spec模板/README.md`
    - `specs/spec001-DeepSeekHarness-Codingns4DSH单一插件/README.md`
  - Main files:
    - `specs/spec001.1-Codingns4DSH插件版本升级与免重启激活/README.md`
    - `specs/spec001.1-Codingns4DSH插件版本升级与免重启激活/requirements.md`
    - `specs/spec001.1-Codingns4DSH插件版本升级与免重启激活/design.md`
    - `specs/spec001.1-Codingns4DSH插件版本升级与免重启激活/tasks.md`
  - Explicit non-goals: No source-code, profile, Desktop, or package changes.
  - Done when: The four main documents, supplementary-doc index, dated investigation, and parent Spec link exist and have matching scope.
  - Verify: Manual document consistency review.
  - Requirements/design: All requirements; design §§1-8.

- [x] 0.2 Record the current feasibility evidence
  - Status: DONE
  - What this does: Record the npm/GitHub baseline and the DSH package-manager, HMR, and Desktop ownership constraints found during the read-only investigation.
  - What becomes visible: Later implementation tasks can distinguish verified facts from assumptions.
  - Dependencies: 0.1.
  - Read first:
    - `specs/spec001.1-Codingns4DSH插件版本升级与免重启激活/design.md` §8
    - `README.md:261`
    - `package.json`
  - Main files:
    - `docs/调查报告/20261025-Codingns4DSH插件更新与免重启激活可行性调查.md`
    - `specs/spec001.1-Codingns4DSH插件版本升级与免重启激活/README.md`
  - Explicit non-goals: No live Desktop operation and no installation test.
  - Done when: npm channel behavior, exact GitHub tag behavior, DSH manager boundary, HMR limitation, and unresolved Desktop capability are linked and dated.
  - Verify: Read-only source and public-source review.
  - Requirements/design: Requirements 2-7; design §8.

- [x] 0.3 Review the initial Spec boundary
  - Status: DONE
  - What this does: Check that “check”, “review”, “install”, “activate Host”, and “reload Client” are separate tasks and result states.
  - What becomes visible: The implementation cannot accidentally promise that package installation alone is a live update.
  - Dependencies: 0.1, 0.2.
  - Read first:
    - `requirements.md`
    - `design.md` §§3-6
    - `tasks.md`
  - Main files: All Spec001.1 documents and the dated investigation.
  - Explicit non-goals: No new feature scope during the review.
  - Done when: Every requirement maps to a design section and at least one task or verification item.
  - Verify: Manual traceability review.
  - Requirements/design: All requirements; design §7.

## Phase 1: Verify and expose the DSH update capability

- [x] 1.1 Pin the supported DSH Plugin Manager contract
  - Status: DONE
  - Evidence: Published 0.2.1-rc.2 declarations and implementation inspected; `installBundle` and `cancelInstall` signatures and the HMR `already-installed` restriction are recorded in the dated contract investigation.
  - What this does: Inspect the exact supported DSH release package and source to identify the public read, update, progress, cancellation, and result APIs.
  - What becomes visible: Codingns4DSH has a release-pinned adapter contract instead of depending on `master` documentation or guessed method names.
  - Dependencies: 0.3.
  - Read first:
    - `docs/调查报告/20261025-Codingns4DSH插件更新与免重启激活可行性调查.md`
    - `design.md` §§2.3, 3.3, 8.2
    - Exact DSH release source and published declarations
  - Main files:
    - `src/dsh-capabilities/matrix.ts`
    - `src/dsh-capabilities/routes.ts`
    - `src/dsh-capabilities/types.ts`
    - A dated investigation under `docs/调查报告/`
  - Explicit non-goals: No package installation and no Desktop profile changes.
  - Done when: The supported DSH versions, capability names, signatures, result states, owner scope, and missing-capability diagnostics are documented.
  - Verify: Release-pinned source/declaration review and capability fixture tests.
  - Requirements/design: Requirements 4-7; design §§2.3, 3.3, 8.2.

- [x] 1.2 Add the internal update and activation capability boundary
  - Status: DONE
  - Evidence: Four stable capability IDs, matrix entries, structural manager probes, explicit Client-unavailable route, old-version fixtures, and Cordis Context probe tests. Capability report regenerated.
  - What this does: Add stable CodingNS capability IDs and adapters for package inspection, package update, Host activation, and Client reload.
  - What becomes visible: Business code depends on CodingNS contracts rather than DSH version-specific types.
  - Dependencies: 1.1.
  - Read first:
    - `requirements.md` Requirements 4-7
    - `design.md` §2.3 and §3.3
    - Existing capability registry and route patterns
  - Main files:
    - `src/dsh-capabilities/types.ts`
    - `src/dsh-capabilities/matrix.ts`
    - `src/dsh-capabilities/routes.ts`
    - `src/dsh-capabilities/host/`
    - `src/dsh-capabilities/client/`
    - `tests/dsh-capabilities*.spec.ts`
  - Explicit non-goals: No settings UI and no direct npm/pnpm invocation.
  - Done when: Unsupported DSH versions produce explainable diagnostics and fake Context fixtures cover supported and missing capability paths.
  - Verify: `pnpm run capability:report`; `pnpm run capability:check`; focused capability tests.
  - Requirements/design: Requirements 4-7; design §§2.3, 6.4.

- [x] 1.3 Verify the privileged operation boundary
  - Status: DONE
  - Evidence: Owner and local-provenance rejection tests, explicit confirmation and check expiry tests, stale-target and duplicate-operation rejection. Legacy Fetch routes expose updater reads only.
  - What this does: Confirm that only the Host owner can request a mutating update and that peer/remote calls never reach the manager adapter.
  - What becomes visible: The package update has the same owner boundary as other privileged Host operations.
  - Dependencies: 1.2.
  - Read first:
    - `requirements.md` Requirement 8
    - `design.md` §§3.3.2, 5.3
    - Existing `admitCodingNsPeer` and owner checks
  - Main files:
    - `src/host/rpc.ts`
    - `src/dsh-capabilities/host/connection-peer-adapter.ts`
    - `tests/host-rpc*.spec.ts`
  - Explicit non-goals: No real package-manager operation.
  - Done when: Owner, peer, remote, malformed, stale, and duplicate-operation cases have tests.
  - Verify: Focused RPC authorization tests and `git diff --check`.
  - Requirements/design: Requirement 8; design §§3.3.2, 5.3, 6.3.

### Phase check

- [x] 1.4 Verify the DSH capability boundary
  - Status: DONE
  - Evidence: Focused capability/manager tests and `pnpm run capability:check` passed. No real package operation was used.
  - What this does: Confirm that the implementation can either call an official manager or explain why the current DSH cannot support the operation.
  - What becomes visible: The next phase does not build an updater on an unverified API.
  - Dependencies: 1.1, 1.2, 1.3.
  - Read first: All Phase 1 files and the release-pinned investigation.
  - Main files: All Phase 1 files and tests.
  - Explicit non-goals: No Desktop installation or restart.
  - Done when: Capability status, owner policy, operation outcomes, and unsupported diagnostics are stable.
  - Verify: Capability checks, focused tests, and manual traceability review.
  - Requirements/design: Requirements 4-8; design §§2.3, 5, 6.

## Phase 2: Implement version and release-note metadata

- [x] 2.1 Implement npm channel and exact-version metadata
  - Status: DONE
  - Evidence: Fixed package/registry, explicit channels, semantic ordering, publication/gitHead metadata, conservative engines/peer checks, and coalescing tests in `tests/plugin-update.spec.ts`.
  - What this does: Add a Host-side registry adapter for `latest`, `next`, and exact versions, including semver ordering and compatibility metadata.
  - What becomes visible: The settings UI can distinguish stable, prerelease, older, newer, incompatible, and unknown targets.
  - Dependencies: 1.4.
  - Read first:
    - `requirements.md` Requirements 1-4
    - `design.md` §§3.2.1-3.2.3, 3.4, 4.2
    - Existing version parser and Host HTTP patterns
  - Main files:
    - `src/host/update/metadata.ts`
    - `src/shared/contracts/plugin-update.ts`
    - `tests/plugin-update.spec.ts`
  - Explicit non-goals: No package mutation and no settings UI.
  - Done when: Channel selection, prerelease comparison, publication data, `gitHead`, engines, peers, and registry failures are deterministic.
  - Verify: Focused metadata tests using fake registry responses.
  - Requirements/design: Requirements 1-4; design §§3.2, 3.4, 6.1.

- [x] 2.2 Implement exact GitHub release-note lookup
  - Status: DONE
  - Evidence: Exact ref and release validation, bounded annotated-tag traversal, commit mismatch, missing notes, oversized content, rate limits, and escaped text tested.
  - What this does: Resolve `v<version>` only, verify the tag/commit relationship, bound and sanitize the release body, and report missing releases without branch fallback.
  - What becomes visible: The review panel shows the exact release content for the selected npm target.
  - Dependencies: 2.1.
  - Read first:
    - `requirements.md` Requirement 3
    - `design.md` §§3.2.3, 3.4, 5.2
    - `docs/调查报告/20261025-Codingns4DSH插件更新与免重启激活可行性调查.md`
  - Main files:
    - `src/host/update/release-notes.ts`
    - `src/shared/contracts/plugin-update.ts`
    - `tests/plugin-update.spec.ts`
  - Explicit non-goals: No arbitrary Markdown-to-HTML execution and no repository branch scraping.
  - Done when: Matching tag, missing release, wrong tag, oversized body, unsafe markup, rate limit, and commit mismatch are covered.
  - Verify: Focused GitHub adapter and sanitization tests.
  - Requirements/design: Requirement 3; design §§3.2.3, 3.4, 5.2.

- [x] 2.3 Add read-only update RPC and Client state store
  - Status: DONE
  - Evidence: `update/runtime` and `update/check` operate independently; prior metadata survives errors; tests cover stale responses, coalescing, stable snapshots, disposal, monotonic status revisions, operation-scoped cancellation responses, and recovery during pending apply.
  - What this does: Expose `update/check` and a stable Client store with request coalescing, stale-response rejection, and disposal.
  - What becomes visible: The settings panel can refresh metadata without affecting existing feature settings.
  - Dependencies: 2.1, 2.2.
  - Read first:
    - `requirements.md` Requirements 1-4 and 9
    - `design.md` §§3.3.1, 4.2, 5.3
    - Existing `src/client/settings-bridge.ts`
  - Main files:
    - `src/host/rpc.ts`
    - `src/client/update-store.ts`
    - `src/shared/contracts/plugin-update.ts`
    - `tests/plugin-update.spec.ts`
  - Explicit non-goals: No update mutation or Desktop operation.
  - Done when: Client can represent idle, checking, ready, unavailable, unsupported, and stale states.
  - Verify: Focused Host RPC and Client store tests.
  - Requirements/design: Requirements 1-4, 9; design §§3.3.1, 4.2, 5.3.

### Phase check

- [x] 2.4 Verify metadata integrity
  - Status: DONE
  - Evidence: Focused tests and typecheck passed; npm checks and GitHub notes correlate through exact versions and tags.
  - What this does: Confirm that one checked target maps to one exact npm manifest and one exact GitHub tag/release state.
  - What becomes visible: The UI can safely ask the user to review a target before mutation.
  - Dependencies: 2.1, 2.2, 2.3.
  - Read first: All Phase 2 files and tests.
  - Main files: All Phase 2 files and tests.
  - Explicit non-goals: No package installation.
  - Done when: Exact-target correlation, stale checks, sanitization, and compatibility states pass.
  - Verify: Focused tests, typecheck, and `git diff --check`.
  - Requirements/design: Requirements 1-4; design §§4.1, 6.1.

## Phase 3: Add settings review and update confirmation

- [x] 3.1 Integrate updater details with Codingns4DSH settings
  - Status: DONE
  - Evidence: The header version pill now expands a single-column themed update panel. The standalone card/switch is removed. Hook-renderer and real Chromium/HTTP tests verify exact-version confirmation, safe text rendering, offline retention, channel selection, incompatible targets, and a mobile layout without horizontal overflow; i18n check passed.
  - What this does: Render current versions, channel selection, target release notes, compatibility, and explicit update confirmation in the existing settings language/theme system.
  - What becomes visible: Users can inspect the exact target before a package mutation.
  - Dependencies: 2.4.
  - Read first:
    - `requirements.md` Requirements 1-4 and 9
    - `design.md` §§3.2, 4.2, 7
    - `src/client/settings-section.ts`
    - `docs/开发规范/20260922-设置选项与表单开发规则.md`
  - Main files:
    - `src/client/settings-section.ts`
    - `src/client/update-panel.ts`
    - `src/client/locales/`
    - `tests/plugin-update.spec.ts`
  - Explicit non-goals: No direct package operation from React and no Desktop GUI automation.
  - Done when: Stable/prerelease/exact channels, release-note missing state, compatibility block, confirmation, loading, error, and narrow layout are covered.
  - Verify: Focused Client/DOM tests and `pnpm run i18n:check`.
  - Requirements/design: Requirements 1-4, 9; design §§3.2, 4.2, 7.3.

- [x] 3.2 Add update progress, cancellation, and recovery UI
  - Status: DONE
  - Evidence: Host operation IDs and revisions, bounded recovery history, manager progress/cancellation, serial polling, visibility pause, and stale-response rejection. Chromium acceptance covers recovery after page reload, cancellation/rollback fixture outcomes, runtime-version refresh, and truthful restart-required results.
  - What this does: Render manager progress and recoverable operation status without losing the last known target or showing false success.
  - What becomes visible: Users can see checking, installing, cancelling, rollback, failure, and pending activation states.
  - Dependencies: 3.1 and Phase 4 capability adapter.
  - Read first:
    - `requirements.md` Requirements 5-6
    - `design.md` §§3.2.4, 4.2, 5.3
  - Main files:
    - `src/client/update-store.ts`
    - `src/client/update-panel.ts`
    - `src/host/rpc.ts`
    - `tests/plugin-update.spec.ts`
  - Explicit non-goals: No UI claim that package installation equals activation.
  - Done when: Operation recovery by `operationId`, stale progress rejection, cancellation, rollback, and restart-required instructions are tested.
  - Verify: Focused operation-state tests.
  - Requirements/design: Requirements 5-6; design §§3.2.4, 4.2, 5.3.

- [x] 3.3 Move the updater entry into the top version information
  - Status: DONE
  - Evidence: The existing version pill is an accessible disclosure button with a new-version label populated by one bounded check per visible settings mount. Header and details share one store; collapsing preserves state. Registry tests verify there is no updater settings card. The isolated focused selection passed all 65 cases, including header integration, Client entry, banner styling, and Chromium acceptance. All new cases also passed in the full compiled suite. Wide/light, wide/dark, and mobile screenshots were inspected.
  - Main files: `src/client/settings-update.ts`, `src/client/settings-promo.ts`, `src/client/settings-promo-styles.ts`, `src/client/settings-section.ts`, `src/client/update-panel.ts`, `tests/plugin-update-browser.spec.ts`.
  - Requirements/design: Requirement 1; design §3.1.1.

- [x] 3.4 Restore original banner geometry and prevent badge layout shifts
  - Status: DONE
  - Evidence: Restored the non-wrapping brand/message/GitHub row, kept details in a separate sibling, restored original pill height, and reserved fixed space for the compact `New` label. All 65 isolated focused cases passed. Chromium compared the original header geometry with badge-present, badge-absent, and long-version states in seven configurations: English/Chinese, desktop/narrow panels/mobile, and 150% zoom. Column positions, pill dimensions, and banner height matched within one pixel; screenshots were inspected.
  - Main files: `src/client/settings-promo.ts`, `src/client/settings-promo-styles.ts`, `src/client/settings-update.ts`, `tests/plugin-update-browser.spec.ts`, `tests/fixtures/plugin-update-panel.ts`.
  - Verification scope: Typecheck, version, capability, i18n, production build, focused tests, pack/extraction, and packaged-module smoke checks passed. The full suite was not repeated for this layout correction.
  - Requirements/design: Requirement 1.6; design §3.1.1.

- [x] 3.5 Adapt updater locale and improve detail presentation
  - Status: DONE
  - Evidence: Replaced the English-only Chinese dictionary with full Chinese translations, added locale-specific date formatting, and added scoped updater styles for version cards, state highlights, target metadata, confirmation, operation status, and bounded monospace release notes. The browser fixture switches the complete updater dictionary between English and Chinese. All 65 isolated focused tests passed, including the real browser workflow, i18n check, build, package, and smoke checks.
  - Main files: `src/client/locales/pluginUpdate.ts`, `src/client/update-panel.ts`, `src/client/update-panel-styles.ts`, `tests/fixtures/plugin-update-panel.ts`, `tests/plugin-update-browser.spec.ts`.
  - Requirements/design: Requirements 1-3 and 9; design §§3.1.1, 7.

## Phase 4: Implement official update and activation flow

- [x] 4.1 Implement the DSH manager update adapter
  - Status: DONE
  - Evidence: Official exact-target `installBundle` signature and cancellation tested with fake managers. Unsupported HMR/Desktop routes are blocked; no direct package subprocess or profile write exists.
  - What this does: Call the release-pinned official package operation with an exact target after compatibility and owner checks.
  - What becomes visible: A confirmed update changes the package only through DSH-owned locking and rollback rules.
  - Dependencies: 1.4, 2.4, 3.1.
  - Read first:
    - `requirements.md` Requirement 5
    - `design.md` §§2.1, 3.3.2, 5.3
    - Exact DSH manager declarations from task 1.1
  - Main files:
    - `src/dsh-capabilities/host/plugin-update-adapter.ts`
    - `src/host/update/service.ts`
    - `src/host/rpc.ts`
    - `tests/plugin-update.spec.ts`
  - Explicit non-goals: No direct `pnpm`, profile file edits, or Desktop-side fallback implementation.
  - Done when: Exact target, compatibility, progress, cancellation, rollback, failure, and unsupported-manager outcomes map to the internal contract.
  - Verify: Fake manager integration tests; static check that the feature does not spawn package-manager subprocesses.
  - Requirements/design: Requirement 5; design §§2.1, 3.3.2, 5.3.

- [x] 4.2 Implement Host activation status
  - Status: DONE
  - Evidence: Loaded Host version is distinct from the accepted package version. Native restart-required and unconfirmed lifecycle outcomes remain non-success. No private loader access is used.
  - What this does: Observe the DSH Host lifecycle result and determine whether the target Host code is active.
  - What becomes visible: Package installation is not reported as Host activation unless DSH confirms it.
  - Dependencies: 4.1.
  - Read first:
    - `requirements.md` Requirements 6-7
    - `design.md` §§3.2.4, 4.3, 6.2, 6.4
  - Main files:
    - `src/host/update/service.ts`
    - `src/host/update/application-result.ts`
    - `tests/plugin-update.spec.ts`
  - Explicit non-goals: No private Cordis loader or ESM cache access.
  - Done when: Applied, pending, failed, unsupported, and restart-required Host outcomes are distinguishable.
  - Verify: Fake Host lifecycle and activation truth-table tests.
  - Requirements/design: Requirements 6-7; design §§4.3, 6.2, 6.4.

- [ ] 4.3 Implement Client reload status
  - Status: BLOCKED
  - Blocker: No supported Desktop-owned Client replacement/status contract was established for DSH 0.2.1-rc.2. The explicit unsupported adapter and Web-vs-Desktop fallback tests are implemented. Actual Client replacement remains unimplemented.
  - What this does: Integrate the official DSH Client graph/reload capability where supported and report whether the target Client code is active.
  - What becomes visible: The updater does not call Web-only HMR or a generic page reload and then claim Desktop Client activation.
  - Dependencies: 4.2 and exact Desktop capability confirmation from task 1.1.
  - Read first:
    - `requirements.md` Requirements 6-7
    - `design.md` §§2.3, 4.3, 8.2
    - Exact DSH Client HMR/Desktop declarations
  - Main files:
    - `src/dsh-capabilities/client/plugin-reload-adapter.ts`
    - `src/client/update-panel.ts`
    - `tests/plugin-update.spec.ts`
  - Explicit non-goals: No forced `location.reload`, Electron automation, or Desktop process restart.
  - Done when: Active, pending, unsupported, failed, and stale Client graph results are represented.
  - Verify: Fake Client graph/reload tests and Web-vs-Desktop capability fixtures.
  - Requirements/design: Requirements 6-7; design §§2.3, 4.3, 6.2.

- [x] 4.4 Add final result derivation and `update/apply` RPC
  - Status: DONE
  - Evidence: Exhaustive package/Host/Client state truth table, version mismatch rejection, confirmation/recheck gates, and operation recovery tested. The production adapter cannot claim live success.
  - What this does: Combine package, Host, and Client facts into the final application result and expose operation recovery.
  - What becomes visible: The UI can say “active without Desktop restart” only when the full truth table passes.
  - Dependencies: 4.1, 4.2, 4.3.
  - Read first:
    - `requirements.md` Requirement 6
    - `design.md` §4.3
  - Main files:
    - `src/host/update/application-result.ts`
    - `src/host/rpc.ts`
    - `src/shared/contracts/plugin-update.ts`
    - `tests/plugin-update.spec.ts`
  - Explicit non-goals: No optimistic success and no automatic Desktop restart.
  - Done when: Every package/Host/Client combination has a deterministic final result and next step.
  - Verify: Complete activation truth-table tests and focused RPC tests.
  - Requirements/design: Requirement 6; design §§3.2.4, 4.3, 6.2.

### Phase check

- [x] 4.5 Verify the no-Desktop-restart claim
  - Status: DONE
  - Evidence: Verified the conservative fallback, not live Desktop replacement. Independent active target versions are required by the truth table; current Client capability remains unavailable, so production reports restart-required or unknown.
  - What this does: Prove that the supported DSH capability returns independent live Host and Client evidence before enabling the success copy.
  - What becomes visible: The feature either gives a defensible live-update result or falls back to restart-required.
  - Dependencies: 4.1, 4.2, 4.3, 4.4.
  - Read first: All activation adapters, `requirements.md` Requirement 6, and `design.md` §§4.3, 8.2.
  - Main files: Activation adapters, contracts, tests, and dated evidence.
  - Explicit non-goals: No unapproved Desktop operation.
  - Done when: The capability evidence is release-pinned and the success path cannot be reached by a package-install result alone.
  - Verify: Fake capability matrix plus any separately authorized runtime validation; otherwise record the feature as restart-required.
  - Requirements/design: Requirements 6-7; design §§4.3, 6.2, 8.2.

## Phase 5: Final verification and handoff

- [x] 5.1 Run repository verification
  - Status: DONE
  - Evidence: Isolated typecheck, version check, capability retirement, i18n, production build, npm tarball extraction/export/module-loading smoke checks, and all 65 focused updater/banner/Client-entry cases passed, including the layout correction. Last full compiled run before that correction: 4,036 tests, 4,006 passed, one failed, 29 skipped; all 33 updater/browser cases passed within that run. The ordinary `pnpm test` command ran in the preceding implementation phase with its earlier case totals; the current isolated runner executes the same production build and compiled test pipeline. Whitespace and source/snapshot consistency checks passed.
  - Verification limitation: The full suite is not green. Its only failure is the committed `tests/contracts.spec.ts` expectation that omits the committed `sessionHandleEviction` default. Both files were left unchanged. Live/platform-specific tests unavailable in the isolated environment were skipped; no real DSH package operation was performed.
  - What this does: Run the required static checks and focused/full tests after implementation.
  - What becomes visible: The updater does not regress existing features or compatibility checks.
  - Dependencies: 4.5.
  - Read first:
    - `AGENTS.md` verification commands
    - `requirements.md`
    - `design.md`
    - All task evidence
  - Main files:
    - Spec001.1 documents
    - A dated implementation record under `docs/开发记录/`
  - Explicit non-goals: No development/application server start, Desktop operation, commit, release, push, or npm publish. The user authorized isolated builds and disposable browser/HTTP test fixtures.
  - Done when: All required commands have actual results and unsupported live activation limits are explicit.
  - Verify:
    - `pnpm run typecheck`
    - `pnpm run version:check`
    - `pnpm run capability:check`
    - `pnpm test`
    - `git diff --check`
  - Requirements/design: All requirements; design §7.

- [ ] 5.2 Final Spec review
  - Status: BLOCKED
  - Evidence: Source review, requirement-to-test mapping, isolated browser acceptance, and packaged verification are complete. Exact manager signatures, regression results, and unsupported Desktop behavior are documented.
  - Blocker: Task 4.3 needs an official Desktop-owned package/reload contract that survives plugin replacement and independently confirms active Host and Client resources. This repository cannot establish that contract. Actual DSH package replacement/rollback and Desktop live activation were not tested; production uses explicit fallback. The unrelated defaults-test failure also remains visible in the verification record.
  - What this does: Confirm that requirements, design, code, tests, and activation evidence agree.
  - What becomes visible: A handoff-ready update feature with no unsupported Desktop promise.
  - Dependencies: 5.1.
  - Read first: All Spec001.1 documents and the dated implementation record.
  - Main files: Spec001.1 documents, changed source/tests, and verification record.
  - Explicit non-goals: No additional feature scope.
  - Done when: Every acceptance criterion has code/test/evidence mapping and all unverified Desktop behavior is documented.
  - Verify: Manual traceability review, `git status --short`, and `git diff --check`.
  - Requirements/design: All requirements; full design.

