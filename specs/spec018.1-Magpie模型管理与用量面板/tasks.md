# Tasks: Magpie Management and Usage Panel (Human-readable)

Status: Native sidebar entry, full usage dashboard, Web-API-backed provider/group/account management, complete provider model inventories, drag-and-drop routing-group ordering, provider-nested primary/secondary accounts, Host-owned automatic Magpie Web startup, and outdated-Host diagnosis implemented.

## Status labels

- `TODO`: not started
- `IN_PROGRESS`: underway
- `BLOCKED`: an external dependency prevents safe completion
- `DONE`: implemented, verified, and recorded

Each task states what changes, what becomes visible, dependencies, documents to read, files in scope, explicit non-goals, and verification.

## Phase 0: Establish feasibility

- [x] 0.1 Verify current Magpie fields and management surfaces
  - Status: DONE
  - What changes: Capture a read-only live-device interface report before implementation.
  - What becomes visible: A dated report with field names, methods, write boundaries, and real-device results.
  - Dependencies: None.
  - Read first: `requirements.md`; current Spec018; `src/host/cli-adapters/magpie-usage.ts`.
  - Main files: `docs/20261022-Magpie管理与完整用量可行性调查.md`.
  - Explicit non-goals: No provider, account, group, Agent, or Desktop writes.
  - Done when: Live CLI and local Gateway reads are summarized without account values or credentials.
  - Verify: Inspect the dated report against the recorded read-only command/API results.
  - Requirements/design: R6; `design.md` §5.

## Phase 1: Add the Host data boundary

- [x] 1.1 Define dashboard and request contracts/parsers
  - Status: DONE
  - What changes: Add graph-ready safe contracts and bounded parsers for aggregate usage, groups, request rows, quota cards, daily data, and quota history.
  - What becomes visible: The Host can return a typed dashboard snapshot without raw Magpie JSON.
  - Dependencies: 0.1.
  - Read first: `requirements.md` R2-R5; `design.md` §§2-3; feasibility report.
  - Main files: `src/shared/contracts/magpie-management.ts`; `src/host/cli-adapters/magpie-usage.ts`; focused tests.
  - Explicit non-goals: No configuration writes, provider keys, raw request content, or currency guessing.
  - Done when: Every observed metric and graph group is normalized and bounded.
  - Verify: Focused parser tests.
  - Requirements/design: R2-R5; `design.md` §§2-3.

- [x] 1.2 Register bounded dashboard RPCs
  - Status: DONE
  - What changes: Add `magpie/usage/dashboard` and `magpie/usage/requests` with a feature-enabled gate, fixed Gateway paths, pagination limits, cancellation, and exact session post-filtering.
  - What becomes visible: An enabled Client can load period snapshots and matching session request pages through the Host.
  - Dependencies: 1.1.
  - Read first: `design.md` §§2.1-2.3; current `cliAdapters` RPC lifecycle and Spec018 privacy boundary.
  - Main files: `src/host/cli-adapters/feature.ts`; `src/host/rpc.ts`; `src/host/cli-adapters/magpie-usage.ts`; tests.
  - Explicit non-goals: No arbitrary origin, free-form endpoint, unbounded page, or remote-host forwarding.
  - Done when: Invalid, disabled, cancelled, or mismatched requests fail closed.
  - Verify: Focused Host RPC/service tests.
  - Requirements/design: R4-R5; `design.md` §§2.3-4.

## Phase 2: Add the opt-in dashboard

- [x] 2.1 Register the opt-in feature toggle
  - Status: DONE
  - What changes: Register `magpieManagement` with the client feature registry and settings RPC allowlist, disabled by default.
  - What becomes visible: An opt-in feature toggle directly after External Agent settings; it no longer contains a dashboard launch button.
  - Dependencies: None.
  - Read first: `requirements.md` R1; `design.md` §2.1; feature registry patterns.
  - Main files: `src/client/features/index.ts`; new client feature module; `src/host/rpc.ts`; tests.
  - Explicit non-goals: No Desktop plugin installation or profile changes.
  - Done when: The feature toggle is persisted and the button is unavailable while disabled.
  - Verify: Feature wiring and settings allowlist tests.
  - Requirements/design: R1; `design.md` §2.1.

- [x] 2.2 Implement the usage page
  - Status: DONE
  - What changes: Add responsive overview charts/cards, provider/model/account breakdowns, sessions, request detail, and quota/history sections.
  - What becomes visible: The full Magpie usage display in a separate main-panel page.
  - Dependencies: 1.2, 2.1.
  - Read first: `requirements.md` R1-R5; `design.md` §§2-4; existing usage panel patterns.
  - Main files: new Client page/panel; `src/client/locales/usage.ts` or an adjacent locale domain; client tests.
  - Explicit non-goals: No account switch, per-account enable toggle, or guessed currency symbol. Provider and routing-group editing are covered by Phase 5.
  - Done when: Period, sessions, exact-session requests, provider/account costs, and quotas work with partial/unavailable data.
  - Verify: Focused UI tests and `pnpm run i18n:check`.
  - Requirements/design: R1-R5; `design.md` §§2-4.

## Phase 4: Use the native global sidebar

- [x] 4.1 Register a paired native sidebar row and main page
  - Status: DONE
  - What changes: Move the dashboard launch entry out of CodingNS settings and register a DSH `sidebar.panellist` row plus matching keyed `main` page while `magpieManagement` is enabled.
  - What becomes visible: “Magpie Management” appears immediately below the native Plugins row; selecting it opens the dashboard in the main panel, and the page returns to the conversation through `layout.selectPanel(null)`.
  - Dependencies: 2.1, 2.2; `sidebar.global-panel` capability.
  - Read first: DSH `ui-sidebar`/`ui-layout` slot contracts and the existing DSH capability boundary.
  - Main files: `src/dsh-capabilities/client/global-panel-adapter.ts`; `src/dsh-capabilities/matrix.ts`; `src/dsh-capabilities/routes.ts`; `src/client/features/magpie-management.ts`; `src/client/features/magpie-management-page.ts`.
  - Explicit non-goals: No hand-created sidebar DOM, modal/fixed overlay, Desktop operation, or Magpie configuration write.
  - Done when: The row and page are registered together only after both slots are declared, both are removed when the module is disabled, and unsupported hosts fail closed.
  - Verify: Capability fixtures, paired registration/cleanup assertions (including ID/order/label/icon), flat-page render and chrome-inset assertions, typecheck, the final 107-test focused source run, capability report/check, and `git diff --check` passed. No live DSH UI verification was performed because the repository prohibits Desktop operations without item-specific authorization.
  - Requirements/design: R1; `design.md` §§1-2, 4, 7.

- [x] 4.2 Use the plain Magpie label and the native Magpie icon in the sidebar row
  - Status: DONE
  - What changes: Rename the row from “Magpie Management / Magpie 管理” to plain **Magpie** in both dictionaries, and replace the self-drawn “M” SVG with a background-free monochrome magpie silhouette traced from the native app icon and inlined as `<svg viewBox="0 0 100 100" fill="currentColor">` (`src/client/features/magpie-mark.ts`), so the row inherits the sidebar text colour in both themes and needs no image request, icon route, or CSS mask.
  - What becomes visible: The sidebar reads “Magpie” and shows the magpie bird as a monochrome mark that matches the neighbouring native icons in light and dark themes, with no light app-icon tile behind it.
  - Dependencies: 4.1.
  - Main files: `src/client/features/magpie-management.ts`; `src/client/locales/magpie.ts`; `tests/magpie-global-panel.spec.ts`.
  - Explicit non-goals: No change to the existing provider logos or the full-colour app icon, no change to the row id/order, page content, or RPC.
  - Done when: The registered row label resolves to `Magpie` and its icon renders the monochrome vector mark in `currentColor` rather than a letter mark or a tiled app icon.
  - Verify: `tests/magpie-global-panel.spec.ts` starts the real feature against fake panel seats and asserts the label plus the inline `currentColor` vector mark with no `<img>` or `mask-image`; focused suites 74/74; i18n check passes.
  - Requirements/design: R1; `docs/开发记录/20261022-Magpie原生侧栏面板入口记录.md` § “Sidebar label and icon”.

## Phase 3: Verify and record

- [x] 3.1 Run checks and record the implementation
  - Status: DONE
  - What changes: Run focused tests/static checks and record results and known management gaps.
  - What becomes visible: A dated development record and completion state for finished tasks.
  - Dependencies: 1.1, 1.2, 2.1, 2.2.
  - Read first: `requirements.md`; `design.md`; `tasks.md`; feasibility report.
  - Main files: tests; this Spec; `docs/开发记录/20261022-Magpie用量面板实现记录.md`.
  - Explicit non-goals: No build/replay/server/Stage0/Desktop action, commit, release, or publication.
  - Done when: Test outcomes and remaining per-account enablement gap are explicit.
  - Verify: See Phase 5.3 and `docs/开发记录/20261022-Magpie管理功能与用量面板记录.md` for the final implementation and verification record.
  - Requirements/design: R1-R6; full `design.md`.

- [x] 3.2 Verify the native sidebar move
  - Status: DONE
  - What changes: Verify the slot pair, feature opt-in lifecycle, flat page semantics, and supported DSH capability gate.
  - What becomes visible: Focused automated verification and a dated development record for the revised entry point.
  - Dependencies: 4.1.
  - Read first: `requirements.md` R1; `design.md` §2; this task file.
  - Main files: `tests/magpie-global-panel.spec.ts`; `tests/magpie-management.spec.ts`; `tests/feature-wiring.spec.ts`; `docs/开发记录/20261022-Magpie原生侧栏面板入口记录.md`.
  - Explicit non-goals: No real-device GUI interaction or Desktop profile change; static and automated checks only.
  - Done when: All recorded commands have actual successful outputs, and any unperformed real-device verification is explicitly noted.
  - Verify: See the dated development record.
  - Requirements/design: R1; `design.md` §§2, 7-8.

- [x] 3.3 Correct dashboard Host RPC routing
  - Status: DONE
  - What changes: Route dashboard and request reads through the standard CodingNS Host channel and namespace, preserving the existing safe Fetch fallback for unsupported native routes.
  - What becomes visible: The page reaches the registered Host `magpie` handler instead of failing at the DSH transport boundary.
  - Dependencies: 1.2, 2.2.
  - Read first: `src/client/rpc-call.ts`; `src/host/rpc.ts`; this task file.
  - Main files: `src/client/features/magpie-management-page.ts`; `tests/magpie-management.spec.ts`.
  - Explicit non-goals: No Desktop operation or Host/profile configuration change.
  - Done when: Automated tests assert `/codingns` plus `magpie/<action>` and the HTTP 404/405 Fetch fallback.
  - Verify: Initial routing verification found the correct Host RPC channel and fallback. The earlier typecheck attempt was blocked by an unrelated worktree edit, but the final `pnpm run typecheck` passed after the implementation was complete; see Phase 5.3. No live Desktop verification was performed under the repository's Desktop isolation rule.
  - Requirements/design: R1-R5; `design.md` §§2-4.

## Phase 5: Add provider and routing-group management

- [x] 5.1 Add safe provider editing and availability controls
  - Status: DONE
  - What changes: Read installed providers through the Magpie CLI and allow editing existing provider names, already-configured plain endpoints, exposed models, and provider on/off state.
  - What becomes visible: The Providers page displays a provider editor with an explicit review step before each mutation.
  - Dependencies: 0.1, 1.1, 2.1, 4.1.
  - Read first: `requirements.md` R6; `design.md` §§2.2, 5; feasibility report.
  - Main files: `src/host/cli-adapters/magpie-management.ts`; `src/shared/contracts/magpie-management.ts`; `src/client/features/magpie-management-controls.ts`; tests.
  - Explicit non-goals: No provider creation/removal, credential/header edits, or unsupported provider fields.
  - Done when: The Host validates all input, serializes writes, and returns success only after a fresh read-back matches.
  - Verify: Isolated Magpie CLI provider name/endpoint/model/on-off round-trips and model-clear checks passed; provider credentials are omitted from normalized output. Focused regression tests pass.
  - Requirements/design: R6; `design.md` §§2.2, 5, 7.

- [x] 5.2 Add routing-group editor and initial read-only account status
  - Status: DONE
  - What changes: Parse version-gated Magpie group list/detail output, edit only name, ordered models/patterns, routing policy, and stickiness, and show account `active`/`on` and allowance data read-only.
  - What becomes visible: Routing Groups exposes reviewed changes; the initial Accounts view showed supported status/quota fields without an account toggle. Phase 7 supersedes that restriction with a verified Web API path.
  - Dependencies: 0.1, 1.1, 2.1, 4.1.
  - Read first: `requirements.md` R6; `design.md` §§2.2, 5; feasibility report.
  - Main files: `src/host/cli-adapters/magpie-management.ts`; `src/shared/contracts/magpie-management.ts`; `src/client/features/magpie-management-controls.ts`; tests.
  - Explicit non-goals at this stage: No group creation/removal, account switching, per-account enablement through the CLI, or fields lacking verified read-back.
  - Done when: Unknown CLI output fails closed; every mutation is allowlisted and checked after a fresh read; failed group writes do not change provider or other-group state.
  - Verify: Isolated group model/order/policy/stickiness and pattern-preservation round-trips passed. Group write-failure isolation tests pass. `accounts --json` parsing is read-only and strips credential fields.
  - Requirements/design: R6; `design.md` §§2.2, 5, 7.

- [x] 5.3 Run final feature verification and reconcile records
  - Status: DONE
  - What changes: Update the Spec status and historical implementation records; run the focused test suite and static checks without building or starting DSH.
  - What becomes visible: Final verification results and the remaining per-account enablement limitation are recorded.
  - Dependencies: 5.1, 5.2.
  - Read first: `README.md`; `requirements.md`; `design.md`; feasibility report; previous Magpie development records.
  - Main files: this Spec; `docs/开发记录/20261022-Magpie管理功能与用量面板记录.md`; earlier Magpie implementation records.
  - Explicit non-goals: No build, server, Stage0, Desktop process/profile, GUI, commit, or release operation.
  - Done when: Focused implementation tests and static checks pass, and known gaps are explicit.
  - Verify: `node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/magpie-global-panel.spec.ts tests/magpie-management.spec.ts tests/magpie-usage.spec.ts tests/dsh-capability-registry.spec.ts tests/feature-wiring.spec.ts` passed 107 tests; `node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/cli-adapters.spec.ts` passed 105 tests after updating its namespace expectation to include the newly registered `magpie` RPC. `pnpm run typecheck`, `pnpm run version:check`, `pnpm run capability:check`, and `pnpm run i18n:check` passed; i18n has 0 blocking violations and existing diagnostic warnings. Live isolated CLI evidence is in the feasibility report. No build or DSH Desktop operation was performed.
  - Requirements/design: R1-R6; full `design.md`.

## Phase 6: Diagnose management-only Host failures

- [x] 6.1 Distinguish an older Host from a broken Host connection
  - Status: DONE
  - What changes: Preserve the safe Host RPC error code/message, recognize the older Magpie handler's `Unknown Magpie RPC: management/...` response, and return a stable `CODINGNS_RPC_NOT_FOUND` code for unknown actions on the current Host.
  - What becomes visible: Management pages tell users to update/reload CodingNS when usage RPCs exist but management RPCs do not, instead of reporting a generic Host connection failure.
  - Dependencies: 5.1, 5.2.
  - Read first: `src/client/features/magpie-management-page.ts`; `src/host/cli-adapters/feature.ts`; the reported management-only failure.
  - Main files: `src/client/features/magpie-management-page.ts`; `src/client/locales/magpie.ts`; `src/host/cli-adapters/feature.ts`; `tests/magpie-management.spec.ts`.
  - Explicit non-goals: No Desktop GUI, profile, process, Stage0, or installed-plugin operations; no retry of provider/group writes.
  - Done when: The legacy unknown-management-action response is recognized, disabled-feature and transport errors remain distinct, and current fallback routes remain registered.
  - Verify: See the management failure diagnosis and verification results in `docs/开发记录/20261022-Magpie管理功能与用量面板记录.md`.
  - Requirements/design: R1; `design.md` §§2.3, 6-7.

## Phase 7: Merge provider/account management and enable Web API account routing

- [x] 7.1 Present accounts as primary/secondary children of providers
  - Status: DONE
  - What changes: Remove the standalone Accounts management section; nest exact Agent/provider matches under their provider, mark the signed-in account primary and other accounts secondary, and retain unmatched accounts separately.
  - What becomes visible: Provider editing and subscription-account controls share one provider-first panel with an explicit parent relationship.
  - Dependencies: 5.2.
  - Read first: `requirements.md` R6; `design.md` §§2.2, 5; the account rows returned by `magpie accounts --json`.
  - Main files: `src/client/features/magpie-management-controls.ts`; `tests/magpie-global-panel.spec.ts`; related locales.
  - Explicit non-goals: No inferred parent for unmatched accounts; no sign-in switch.
  - Done when: Static UI tests verify primary-before-secondary ordering and no standalone account nav item.
  - Verify: `tests/magpie-global-panel.spec.ts` passes within the final 216/216 focused source-loader run; primary-before-secondary ordering and absence of a standalone Accounts nav item are asserted.
  - Requirements/design: R6; `design.md` §§2.2, 5.

- [x] 7.2 Use Magpie Web API for per-account routing `on`/`off`
  - Status: DONE
  - What changes: Authenticate to the Host-owned Magpie Web process and call its loopback-only account routing API; require explicit confirmation, prevent disabling the final account in rotation, and verify through fresh Web API read-back.
  - What becomes visible: When Web API auth is available, users can add/remove secondary accounts from rotation and pause/resume the signed-in primary without switching sign-ins.
  - Dependencies: 5.2.
  - Read first: Magpie `v0.1.1322` `internal/gui/providers.go`, `internal/provider/logins_on.go`, and `internal/gui/web.go`; `requirements.md` R6; `design.md` §§2, 5-6.
  - Main files: `src/host/cli-adapters/magpie-management.ts`; `src/shared/contracts/magpie-management.ts`; `src/client/features/magpie-management-controls.ts`; `src/client/locales/magpie.ts`; tests.
  - Explicit non-goals: No credential in Client/RPC, non-loopback target, redirects, account switch, live account mutation, or Desktop action.
  - Done when: Authenticated loopback POST and Web API read-back pass tests; redirects, API errors, and final-account disable fail closed; Agent reseating effects are explained.
  - Verify: `tests/magpie-management.spec.ts` covers both API actions, cookie auth, Web API read-back, key isolation, and final-account protection. The tagged upstream source confirms the action and Agent reseating/catalog-sync side effects. No live account write was made because the isolated profile intentionally contained no signed-in accounts.
  - Requirements/design: R6 and Security; `design.md` §§2.1-2.3, 4-8.

- [x] 7.3 Reconcile feasibility and implementation records
  - Status: DONE
  - What changes: Replace the earlier CLI-only limitation with the discovered Web API capability and record exact conditions and evidence limits.
  - What becomes visible: The Spec and dated reports distinguish historical CLI feasibility from the current Web API implementation and record the isolated live account-data boundary.
  - Dependencies: 7.1, 7.2.
  - Read first: `README.md`; `requirements.md`; `design.md`; feasibility report; implementation record.
  - Main files: Spec018.1 documents; `docs/开发记录/20261022-Magpie管理功能与用量面板记录.md`; the dated 20261023 follow-up report.
  - Explicit non-goals: No release, commit, server, Stage0, Desktop, or live account toggle.
  - Done when: Verification commands and remaining operational prerequisites are recorded accurately.
  - Verify: See Phase 8 for the superseding Web API migration and final verification.
  - Requirements/design: R6; full `design.md`.

## Phase 8: Host-manage Magpie Web and migrate the panel to Web API

- [x] 8.1 Automatically own Magpie Web startup and authentication
  - Status: DONE
  - What changes: Start `magpie web --addr 127.0.0.1:0 --no-open` when the feature is enabled, use a valid Host key or generate a process-local random key, authenticate by the port-scoped cookie handshake, and stop/dispose only the Host-owned child.
  - What becomes visible: The panel no longer depends on a separately launched Magpie Web listener or manual `MAGPIE_WEB_KEY` pairing.
  - Dependencies: Feature lifecycle and Magpie Web API authentication.
  - Main files: `src/host/cli-adapters/magpie-web.ts`; `src/host/cli-adapters/feature.ts`; `tests/magpie-web.spec.ts`; `tests/magpie-management.spec.ts`.
  - Explicit non-goals: Do not attach to, stop, or modify an externally launched Magpie process; do not touch DSH Desktop or Stage0.
  - Done when: Unit tests cover generated/configured keys and lifecycle; the installed Magpie integration test starts the service through the enabled Host feature and confirms cleanup.
  - Verify: Final results recorded in the 20261023 Web API report and development record.

- [x] 8.2 Use Web API for every usage and management panel path
  - Status: DONE
  - What changes: Move dashboard/session/request/quota and provider/account/group reads and writes to authenticated Magpie Web routes; merge account status from nested provider login data and usage/quota feeds; preserve exact session matching, field redaction, write allowlists, read-back, and isolation.
  - What becomes visible: The panel reads structured Web API objects and no longer requires CLI-based provider/group/account management or Gateway usage queries.
  - Dependencies: 8.1.
  - Main files: `src/host/cli-adapters/magpie-usage.ts`; `src/host/cli-adapters/magpie-management.ts`; `src/shared/contracts/magpie-management.ts`; Client panel/locales; focused tests.
  - Explicit non-goals: Model-picker catalog discovery remains on the separate existing CLI path; provider credentials and unverified settings remain hidden.
  - Done when: Focused tests and the real isolated Web API integration verify the complete panel data path and safe provider/group mutations.
  - Verify: Final results recorded in the 20261023 Web API report and development record.

- [x] 8.3 Run installed-Magpie integration against synthetic isolated configuration
  - Status: DONE
  - What changes: Use installed Magpie `0.1.1322` with temporary HOME/XDG paths, no account discovery, cleared proxies, synthetic loopback provider endpoints, and synthetic groups; test automatic Host startup, reads, mutations, read-back, and unrelated-record isolation.
  - What becomes visible: Live proof of the Web API operations used by the panel without writing active user configuration.
  - Dependencies: 8.1, 8.2.
  - Main files: `tests/magpie-web.spec.ts`; `specs/spec018.1-Magpie模型管理与用量面板/docs/20261023-MagpieWeb自动托管与全接口验证.md`.
  - Explicit non-goals: No live OAuth-account write, active Magpie configuration write, DSH server, Stage0, or Desktop operation.
  - Done when: All available synthetic reads/writes return successful Web read-back; account API protocol is covered by controlled service tests because the isolated profile has no login rows.
  - Verify: Final command output is recorded in the dated development record.

- [x] 8.4 Complete final regression and static checks
  - Status: DONE
  - What changes: Run focused and broader source tests, typecheck, version/capability/i18n checks, whitespace validation, and the repository test/build command; refresh generated capability documentation if required.
  - What becomes visible: Final verification result and the precise remaining scope boundary.
  - Dependencies: 8.1-8.3.
  - Main files: Magpie-focused tests; Spec task list; dated reports.
  - Explicit non-goals: No development server, DSH server, Desktop, Stage0, commit, release, or publishing operation.
  - Done when: Every safe requested check passes or is documented with its exact observed scope.
  - Verify: `pnpm run typecheck`, `version:check`, `capability:report`, `capability:check`, `i18n:check`, and `git diff --check` passed. The six-file Magpie-focused suite passed 100 tests with one opt-in integration skipped; the installed-Magpie isolated integration passed 1/1. The completed `pnpm test` run passed 3,811 tests, failed 0, skipped 16, and totaled 3,827 tests; its repository build completed successfully. The initial stale-fixture read-only isolation incident remains recorded in `docs/开发记录/20261023-MagpieWeb自动托管与全接口迁移记录.md` and `specs/spec018.1-Magpie模型管理与用量面板/docs/20261023-MagpieWeb自动托管与全接口验证.md`. No DSH server, Desktop, or Stage0 operation was performed.

## Phase 9: Complete model inventories and routing-group ordering

- [x] 9.1 Replace manual provider model lists with Magpie inventories
  - Status: DONE
  - What changes: Retain every valid model row returned by Magpie, including models that are currently not exposed, and expose the inventory as checkbox controls with enable-all and disable-all actions.
  - What becomes visible: Provider editors show Magpie's complete model inventory in source order using compact native-style rows; checked models are exposed and unchecked models are disabled. Partial or malformed inventories remain safely read-only.
  - Dependencies: 5.1, 8.2.
  - Read first: `src/host/cli-adapters/magpie-management.ts`; `src/client/features/magpie-management-controls.ts`; provider contracts and focused tests.
  - Main files: `src/host/cli-adapters/magpie-management.ts`; `src/client/features/magpie-management-controls.ts`; `tests/magpie-management.spec.ts`; `tests/magpie-global-panel.spec.ts`.
  - Explicit non-goals: No model creation, provider credential editing, or inference of models that Magpie does not return.
  - Done when: Exposed and unexposed rows survive normalization, only checked IDs are submitted, and incomplete inventories fail closed.
  - Verify: Provider parser and UI tests assert complete inventories, checkbox state, bulk enable/disable, and disabled controls for partial inventories.
  - Requirements/design: R6; `design.md` §§2.2, 5, 7.

- [x] 9.2 Replace manual routing-group model textareas with complete ordered choices
  - Status: DONE
  - What changes: Build routing-group candidates from all provider model inventories, retain existing unknown members and patterns as fallback choices, and add compact selected-member rows with drag-and-drop, keyboard move controls, and an add-model selector.
  - What becomes visible: Routing Groups show only selected members and patterns, preserve legacy or currently unavailable entries, and submit selected models in the user's order while preserving Magpie's separate pattern section.
  - Dependencies: 9.1.
  - Read first: `src/client/features/magpie-management-controls.ts`; routing-group contracts; Magpie group serialization tests.
  - Main files: `src/client/features/magpie-management-controls.ts`; `src/client/features/magpie-management-page.ts`; `src/client/locales/magpie.ts`; `tests/magpie-global-panel.spec.ts`.
  - Explicit non-goals: No cross-field ordering between Magpie's `members` and `match` arrays; no deletion of unknown existing members or patterns.
  - Done when: Provider model candidates, unknown existing entries, patterns, drag/drop ordering, keyboard ordering, and backend-compatible serialization are covered.
  - Verify: Routing-group UI tests assert selected-only rendering, compact add-model access, unknown-entry preservation, and `reorderModels()` behavior.
  - Requirements/design: R6; `design.md` §§2.2, 5, 7.

- [x] 9.3 Verify the complete model-list update
  - Status: DONE
  - What changes: Re-run static checks and focused Magpie tests after the inventory and ordering changes, and record the result without starting a server or touching Desktop.
  - What becomes visible: The final records identify the complete model-list behavior and its test boundary.
  - Dependencies: 9.1, 9.2.
  - Main files: this Spec; `docs/开发记录/20261023-MagpieWeb自动托管与全接口迁移记录.md`.
  - Explicit non-goals: No Magpie account mutation, DSH server, Stage0, Desktop operation, commit, release, or publication.
  - Done when: Typecheck, localization validation, whitespace validation, and focused model-management tests pass.
  - Verify: See the final verification section in the dated development record.

## Phase 10: Replace the in-page sidebar with a top tab bar

- [x] 10.1 Move section navigation into the page header
  - Status: DONE
  - What changes: Remove the page-owned left rail and render the six sections (`Providers`, `Routing groups`, `Overview`, `Sessions`, `Requests`, `Subscriptions`) as a horizontal tab bar with icons and an active pill, matching the native Magpie dashboard. Move the period control, captured-at timestamp, and Web API source indicator into a second toolbar row, and renumber section eyebrows to the tab order.
  - What becomes visible: The page is a single content pane beside the DSH sidebar instead of a second sidebar; tabs stay reachable and wrap instead of scrolling the active tab out of view on narrow widths.
  - Dependencies: 2.1-2.4, 5.1, 9.2.
  - Read first: `src/client/features/magpie-management-page.ts`; `tests/magpie-global-panel.spec.ts`.
  - Main files: `src/client/features/magpie-management-page.ts`; `src/client/features/magpie-management-controls.ts`; `tests/magpie-global-panel.spec.ts`.
  - Explicit non-goals: No RPC, contract, or locale-key change; no change to the view content; no DSH shell, Stage0, Desktop, or server operation.
  - Done when: The tab bar renders every section, marks the current one, no rail markup remains, and the existing narrow-screen period rule still holds.
  - Verify: `tests/magpie-global-panel.spec.ts` asserts the tab bar, the active tab marker, and the absence of `codingns-magpie-rail` / `codingns-magpie-nav-item`; typecheck and the focused Magpie suites pass; layout was screenshotted from `renderToStaticMarkup` output at three widths.
  - Requirements/design: R6; `docs/开发记录/20261023-Magpie管理页顶部标签栏改造记录.md`.

## Phase 11: Adopt the native Magpie report layouts

- [x] 11.1 Split navigation into native top tabs plus a Usage sub-tab bar
  - Status: DONE
  - What changes: Replace the flat six-tab bar with the native hierarchy: top tabs `Overview`, `Providers`, `Routing`, `Usage`; Usage hosts its own `Subscriptions`, `Sessions`, `Requests` sub-tabs in the native order. Move the period control to the right of the toolbar so it applies to every view.
  - What becomes visible: Overview stands alone, Providers and Routing stay as management pages, and Usage opens on Subscriptions with Sessions and Requests one click away, matching the native Magpie shell.
  - Dependencies: 10.1.
  - Read first: `src/client/features/magpie-management-page.ts`; `tests/magpie-global-panel.spec.ts`.
  - Main files: `src/client/features/magpie-management-page.ts`; `src/client/locales/magpie.ts`; `tests/magpie-global-panel.spec.ts`.
  - Explicit non-goals: No RPC, contract, or Host change.
  - Done when: Both tab levels render, the Usage order is Subscriptions → Sessions → Requests, and the current tab is marked at each level.
  - Verify: `tests/magpie-global-panel.spec.ts` asserts the four top tabs and the ordered Usage sub-tabs.
  - Requirements/design: R6; `docs/开发记录/20261023-Magpie用量报表原生布局改造记录.md`.

- [x] 11.2 Rebuild Overview, Sessions, Requests, and Subscriptions as native reports
  - Status: DONE
  - What changes: Replace the card/line-chart layout with native report primitives: a bordered statistic strip, a bar chart with metric switch, progress-row breakdowns, Agent filter chips, a request table with the native column set, and subscription quota cards with window bars, sparkline, and reset times.
  - What becomes visible: Overview shows Tokens, cache, reasoning, and requests plus Agent/model/top-session progress rows; Sessions shows Agent chips, aggregate strip, daily trend, and top sessions; Requests shows an aggregate strip and the native ledger columns; Subscriptions mirrors the native allowance cards.
  - Dependencies: 11.1.
  - Read first: native Magpie usage screenshots in the request; `src/shared/contracts/magpie-management.ts`.
  - Main files: `src/client/features/magpie-management-page.ts`; `src/client/locales/magpie.ts`.
  - Explicit non-goals: No new Host metrics, no fabricated data for fields Magpie does not return, no CSV export or advanced filters beyond the available data.
  - Done when: Every report renders from the existing dashboard/request contracts, degrades to its empty state, and keeps the previous accessibility roles.
  - Verify: Focused Magpie suites pass; all four views were rendered from `renderToStaticMarkup` with mock dashboard data and screenshotted at 1600px.
  - Requirements/design: R2-R6; `docs/开发记录/20261023-Magpie用量报表原生布局改造记录.md`.

- [x] 11.3 Simplify the page header and center the top tabs
  - Status: DONE
  - What changes: Remove the page-owned brand block and back button, center the top-level tab bar in a three-column header, and move the period filter to the header's left column so it shares the tab row; hide the period filter on the non-period-scoped Providers and Routing tabs.
  - What becomes visible: A single clean header line — period filter left, tabs centered, refresh right — with no duplicated branding or back affordance; narrow widths wrap the filter onto a second row.
  - Dependencies: 11.1.
  - Main files: `src/client/features/magpie-management-page.ts`; `tests/magpie-global-panel.spec.ts`.
  - Explicit non-goals: No change to view content, data loading, or the DSH-owned navigation.
  - Done when: Brand and back button are gone, tabs are centered, the filter sits left on the same row at usable widths, and management tabs show no filter.
  - Verify: `tests/magpie-global-panel.spec.ts` asserts the removed brand/back markup; header rendered and screenshotted at 1500px and 900px.

## Phase 12: Use the whole phone width when the sidebar is hidden

- [x] 12.1 Drop the frame leading clearance from the page surface and inset only the header
  - Status: DONE
  - What changes: Stop using `--dsh-frame-leading-clearance` as a page-wide left padding. The page keeps its desktop indent through CSS, and under `html[data-codingns-mobile-sidebar="on"]` the indent is zeroed while a new `--mp-leading-inset` (clearance − 20px) pushes only the header's first row past the floating DeepSeek logo button; the header's right padding stays independent so the refresh button sits on the real right edge, and the period row cancels the inset with a negative margin.
  - What becomes visible: On phones the Magpie page fills the entire width below the DSH frame — no blank 72px column — with the whale logo button alone at the top-left as the sidebar entry; header, period filter, statistic strip, charts, and tables all start at the content edge.
  - Dependencies: 11.3.
  - Read first: `src/client/mobile-sidebar-rail-dom.ts` (the clearance contract and floating button); `src/client/features/magpie-management-page.ts`.
  - Main files: `src/client/features/magpie-management-page.ts`; `tests/magpie-global-panel.spec.ts`.
  - Explicit non-goals: No change to the mobile-access module, DSH layout services, RPC, contracts, or locale keys; no host or Desktop operation.
  - Done when: The page root carries no inline `padding-left`, the mobile rule zeroes the page indent, only the header uses the inset, and desktop/tablet layouts keep their current indentation.
  - Verify: `tests/magpie-global-panel.spec.ts` asserts the zeroed mobile indent and the header-only inset; CDP-measured 402×874 render reports page width 402, header width 402, refresh right edge 390, tab origin 64, period origin 12, and no horizontal overflow.
  - Requirements/design: R1.3; `docs/开发记录/20261023-Magpie管理页移动端全宽布局记录.md`.

- [x] 12.2 Tighten the phone report chrome
  - Status: DONE
  - What changes: Hide the toolbar row on phones when it would only repeat the scope label and Web API source, keep it when the Usage sub-tabs live there (`has-tabs`), pin the statistic strip to two columns with explicit row/column dividers and a full-width odd last cell, lower the bar chart to 132px, turn its axis into equal-width grid cells so twelve ticks stop overflowing, tighten panel padding, and enlarge the refresh button to a 36px touch target.
  - What becomes visible: A denser phone report with no empty toolbar band, no horizontally clipped axis labels, and statistic cells that read as a clean 2×N grid.
  - Dependencies: 12.1.
  - Main files: `src/client/features/magpie-management-page.ts`; `tests/magpie-global-panel.spec.ts`.
  - Explicit non-goals: No data, contract, or copy change; no new mobile-only view.
  - Done when: Overview, Usage, and the request ledger render without horizontal page overflow at 402px, and the desktop layout is unchanged.
  - Verify: Screenshots at 402×874 (overview and requests), 768×900, and 1280×900; focused Magpie suites and typecheck pass.
  - Requirements/design: R1.3; `docs/开发记录/20261023-Magpie管理页移动端全宽布局记录.md`.

- [x] 11.4 Adopt the DSH theme for the whole panel
  - Status: DONE
  - What changes: Replace the panel's own palette, card chrome, and typography with DSH theme tokens: `bg-base` page surface, `specific-input-major` cards with 0.5px `border-l2/l3` hairlines, `state-business-primary` accent, DSH segmented controls and underline tabs, and the DSH type scale. Light and dark themes follow automatically.
  - What becomes visible: The panel reads as part of DSH instead of a separately themed dashboard; hairline borders, DSH primary buttons, and DSH accent charts replace the green/indigo palette.
  - Dependencies: 11.2, 11.3.
  - Main files: `src/client/features/magpie-management-page.ts`.
  - Explicit non-goals: No new dependencies, no theme detection code, no change to data or navigation.
  - Done when: No hard-coded brand colors remain in the page CSS, all surfaces resolve from DSH tokens, and both themes render correctly.
  - Verify: `pnpm run typecheck`, focused Magpie suites, `i18n:check`, and light/dark screenshots rendered with the real DSH token values extracted from `@deepseek-ai/dsh-client-ui-theme`.

- [x] 11.5 Make the panel usable on phones and tablets
  - Status: DONE
  - What changes: Below 900px the request ledger switches to a compact card list and the KPI strip becomes a wrapping three-column grid that fills its last row; below 650px paddings, type sizes, chart height, chips, quota cards, and list rows are tightened so the panel stays dense rather than merely scaled down.
  - What becomes visible: On a 390px phone the panel shows the KPI strip in two rows, the ledger as readable cards with the same fields as the table, and quota/session lists without oversized chrome; at 768px the ledger uses cards instead of a table clipped to three columns.
  - Dependencies: 11.2, 11.4.
  - Main files: `src/client/features/magpie-management-page.ts`.
  - Explicit non-goals: No width detection in JS, no separate mobile data path, no change to desktop markup.
  - Done when: The card list and the table share one data source and one set of locale keys, both render correctly, and no layout leaves empty grid cells.
  - Verify: Screenshots captured through CDP device emulation at 390×844 and 768×1024; `pnpm run typecheck`, focused Magpie suites, `i18n:check`, and `git diff --check` pass.

## Phase 13: Add model-level aggregate and account detail views

- [x] 13.1 Let Overview switch model rows between aggregate and per-account modes
  - Status: DONE
  - What changes: Keep the default model breakdown aggregated by model, and add a compact switch for a raw per-account view. The detail view preserves every model row returned by Magpie and displays its account (or provider when Magpie omits the account); the aggregate view sums metrics and never attributes a total to one account.
  - What becomes visible: Repeated models such as `deepseek-v4.1-flash` can be inspected as separate Account A/Account B rows instead of being visually indistinguishable.
  - Dependencies: 11.2.
  - Main files: `src/client/features/magpie-management-page.ts`; `src/client/locales/magpie.ts`; `tests/magpie-global-panel.spec.ts`.
  - Explicit non-goals: No new RPC or raw request fetch; no guessed account-to-model relationship when Magpie does not return the account field.
  - Done when: The overview exposes both modes, aggregate metrics are summed by model, per-account rows retain their account identity, and the detail mode is not truncated to the aggregate top-eight limit.
  - Verify: `tests/magpie-global-panel.spec.ts` covers both render modes and aggregation; typecheck, the full test suite, localization validation, and whitespace validation pass.

## Phase 14: Reuse a successfully detected manual installation path

- [x] 14.1 Share manual detection between settings, enablement, and Web startup
  - Status: DONE — implementation and focused regression coverage complete; the user confirmed Stage0 verification passed on 2026-10-25. Unrelated baseline test failures remain recorded below.
  - What changes: Pass the card's prerequisite state into its settings panel; retain only successful custom-path probes for the Host feature lifetime; force the registered settings gate to revalidate through the feature's detection RPC.
  - Observable result: A runnable executable outside PATH can be detected and immediately enabled, and Web starts with that executable. Failed probes do not replace a working path; a removed executable cannot pass enablement from cache; disabling remains available.
  - Dependencies: Existing installation detection, settings RPC gate, and Host-owned Web lifecycle.
  - Read first: Requirements R1; design sections 2 and 4; settings/form and feature-module development rules; `tests/magpie-install-detection.spec.ts`.
  - Main files: `src/client/features/types.ts`, `src/client/settings-section.ts`, `src/client/features/magpie-management.ts`, `src/host/cli-adapters/feature.ts`, `src/host/rpc.ts`, `tests/magpie-install-detection.spec.ts`.
  - Explicit non-goals: No persistent custom-path setting, PATH change, Magpie installation/configuration change, or operation of DSH Desktop. The subsequent user request authorizes an isolated Stage0 build and launch.
  - Verify: Source-loader installation, Web, management, feature, and RPC suites; typecheck; localization, version, capability, and diff checks; user-performed Stage0 verification. Source tests, server/asset checks, and user verification are recorded separately below.
  - Source evidence (2026-10-25, Windows, Node v24.19.0): `node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/magpie-install-detection.spec.ts tests/magpie-management.spec.ts tests/magpie-web.spec.ts tests/feature-registry.spec.ts tests/feature-wiring.spec.ts tests/cli-adapters-rpc.spec.ts tests/cli-catalog-refresh.spec.ts` — 173 passed, 2 failed, 1 skipped. Both new regression tests pass, covering shared card/panel state, manual-path retention, forced settings validation, Web startup command, failed/late probes, removal, disposal, and disabling.
  - Pre-commit recheck (2026-10-25): `node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 --test-name-pattern 'a successful manual path is shared|the Magpie card and its panel share' tests/magpie-install-detection.spec.ts` — 2 passed, 0 failed.
  - Confirmed baseline failures: The macOS user-bin fallback test on Windows (`tests/magpie-install-detection.spec.ts:96`) and Codex MCP event test (`tests/cli-adapters-rpc.spec.ts:133`) also fail with all `src/` modules loaded from base commit `c781d63` in memory. These are not repaired by this task.
  - Broader adapter evidence: The adapter-rule source command (`tests/cli-adapters*.spec.ts`, `tests/cli-catalog-cache.spec.ts`, `tests/external-agent-pr.spec.ts`, serialized) — 570 passed, 40 failed, 6 skipped. A subsequent run of exactly the 40 failing tests, with all source loaded from unchanged base commit `c781d63`, reproduced all 40 failures. Causes: 24 Claude fake children missing `.once()`, 3 Claude Windows command wrapping assertions, 7 Windows path/URI assumptions (including Qoder drive-letter directory keys), 3 Command Code detection platform assumptions, 2 Antigravity/Codex platform expectations, and 1 ZCode HOME fixture. These failures predate this fix; the broader suite is not green, and not all causes are necessarily test-only.
  - Static evidence: Typecheck via `npx --yes --package=pnpm@10.7.1 pnpm run typecheck` passed; `node scripts/check-client-i18n.mjs` passed with 0 blocking violations and 201 warnings; `node scripts/check-version-sync.mjs`, `node scripts/check-capability-retirement.mjs`, and `git diff --check` passed.
  - Environment: System pnpm 11 attempted an automatic install before checks and failed on dependency build approval. Its generated lockfile/workspace changes were removed, then `pnpm@10.7.1 install --frozen-lockfile --ignore-scripts` synchronized dependencies successfully. No dependency declarations or repository lockfile changed.
  - Stage0 evidence (2026-10-25, subsequently authorized): `npx --yes --package=pnpm@10.7.1 pnpm run build` passed, producing Host, Client, desktop-assistant, and H5 output. Installed the independent DSH `0.2.1-rc.3` runtime under the user's versioned local runtime directory; reused the isolated `.dsh-stage0-020` profile and its existing repository junction. A machine-local PowerShell launcher invokes `scripts/stage0-runtime.mjs` with the same isolated environment as the shell launcher, watch disabled, and explicit loopback binding on port 17891. Authenticated entry HTML, four main JS/CSS assets, and the revisioned combo asset containing CodingNS returned HTTP 200. This establishes server/asset availability, not browser rendering or Magpie UI acceptance. Desktop and both Magpie executable copies were left untouched.
  - User verification (2026-10-25): After receiving the running Stage0 entry URL, the user reported verification passed and requested committing the fix and opening an upstream PR. The user did not supply a step-by-step record or state whether automatic discovery of the `.local/bin/magpie.exe` workaround was isolated; do not present that specific missing-to-manual reproduction as independently observed by the coding agent. Automated regression coverage establishes that transition with isolated discovery fixtures.

## Phase 15: Accept spaces in a manual executable path

- [x] 15.1 Detect and enable a standalone executable under Program Files
  - Status: DONE on `fix/magpie-path-spaces`, based on `origin/main` commit `8950853`.
  - Trigger: `normalizeCustomCommand` rejected all whitespace, so `D:\Program Files\magpie\magpie-windows-amd64.exe` was discarded and detection silently fell back to the automatic search. That directory is not in the automatic search locations on this machine.
  - Change: Accept literal spaces while retaining rejection of control characters, shell syntax, and appended option fragments. Keep the existing Host-session-only selection and automatic search scope unchanged.
  - Regression evidence (2026-10-27, Windows, Node v26.7.0): The normalization test and Host detection/settings gate/Web startup test both failed before the fix with the reported path and passed afterward. `node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/magpie-install-detection.spec.ts tests/magpie-web.spec.ts` returned 26 passed, 1 failed, 1 skipped. The macOS user-bin fallback failure on Windows also reproduces with unchanged source from `8950853`; it remains out of scope. The opt-in isolated Web integration test was skipped.
  - Static evidence: Typecheck, `node scripts/check-version-sync.mjs`, `node scripts/check-capability-retirement.mjs`, and `git diff --check` passed. Typecheck also ran through the isolated runtime's pnpm 10.7.1. No dependency or lockfile changes were made in this repository.
  - Stage0 environment: Installed DSH `0.2.1-rc.3` with pnpm 10.7.1 in `~/.local/share/codingns/deepseek-harness/0.2.1-rc.3`. Created a separate `.dsh-stage0-magpie-path` Home and `~/.config/codingns4dsh/stage0-magpie-path` state, serving loopback port 17892. The profile's source junction points to this repository. Its launcher invokes `scripts/run-dsh-stage0.sh` with automatic compilation; Host watch reported zero errors and the Client bundle completed. HOME, USERPROFILE, APPDATA, LOCALAPPDATA and XDG directories are isolated, and Magpie account discovery is disabled for this validation. Existing Stage0 and Desktop profiles and launchers are unchanged.
  - Browser evidence: In Edge, observed the disabled switch and missing detection; entered the exact unquoted Program Files path; detected real Magpie `0.1.1476`; enabled through the settings switch; opened the populated zero-usage management page; refreshed and reopened settings, confirming the enabled switch and retained detected command. Disabling then removed the Stage0-owned Magpie child; the original Magpie processes remained running. No provider, account or routing configuration was edited and no Magpie update was installed.
  - Local handover: Start with `pwsh.exe -NoLogo -NoProfile -File "$env:USERPROFILE/.config/codingns4dsh/stage0-magpie-path.ps1"` only when port 17892 is free. After successful verification, the user requested deactivation: the Stage0 process tree and compilation watchers were stopped, and port 17892 was confirmed free. The original Magpie application remains running. Configuration and evidence are retained. `run.json`, `verification.json`, runtime logs and `browser-path-enabled.png` are in its state directory; logs contain a local authentication entry and must not be published. The executable selection survives browser refresh, not Host restart, by the existing contract.
  - Not verified: Native Desktop, macOS/Linux execution, full production/H5 build, and persistence across Host restart (not supported). No commit, push, or other branch update was made for this verification.

## Phase 16: Preserve the manual executable path across Host restarts

- [x] 16.1 Persist and revalidate a successfully detected Host-local path
  - Status: DONE on `fix/magpie-path-spaces`, with source based on `4cdeb69` (`0.2.1-rc.7`). This explicitly supersedes the session-only contract and restart limitation recorded in Phases 14 and 15; the space-path fix remains in place.
  - Trigger: The selected detector lived only in the Host feature instance. Restarting DSH discarded the manual path, so the executable outside automatic discovery locations appeared missing again even while the module setting remained enabled.
  - Change: Save only a successfully probed executable path in `magpie-command` under `CODINGNS4DSH_STATE_DIR` (otherwise `~/.config/codingns4dsh`). Read it before initial detection and run a fresh version probe on every Host startup. Atomic replacement and serialized selection writes preserve the previous selection on failed probes or writes; disposal waits for in-flight writes. Do not export the path through settings, synchronize it to PeerHosts, persist a detection result, or modify Magpie configuration.
  - Reset: Add an explicit bilingual restore-automatic-detection action through the existing owner-only detection RPC (`resetCommand: true`). It clears the saved path even when automatic discovery finds nothing. A removed executable stays replaceable or clearable but cannot pass enablement or start Web. Storage errors reject the request instead of reporting a successful save.
  - Main files: `src/host/cli-adapters/magpie-command-store.ts`, `src/host/cli-adapters/feature.ts`, the detection contract, installation prerequisite hook/panel and locale dictionaries; `tests/magpie-command-store.spec.ts` and `tests/magpie-install-detection.spec.ts`.
  - Regression evidence (2026-10-28, Windows): The new store/lifecycle suite has 4 passing tests covering file persistence and isolation, invalid input and storage failures, fresh Host instances and version probes, Web startup, failed overrides, missing executables, reset across restart, and storage-error RPC rejection. Four focused installation tests also pass (normalization, manual path/settings gate/Web startup/lifetime, shared card/panel/reset, owner-only RPC).
  - Broader source evidence: `node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/magpie-command-store.spec.ts tests/magpie-install-detection.spec.ts tests/magpie-web.spec.ts tests/feature-registry.spec.ts tests/feature-wiring.spec.ts` returned 64 passed, 1 failed, 1 skipped. The known macOS user-bin fallback test still fails on Windows; the same detection behavior was reproduced from unchanged `8950853`, and the relevant implementation is unchanged at current HEAD. The opt-in isolated Web integration test was skipped. This is not a fully green regression suite.
  - Static evidence: TypeScript no-emit check, localization check (existing non-blocking warnings), version synchronization, capability retirement, and whitespace validation pass. No dependencies or lockfiles changed.
  - Real Stage0 evidence: Reused the isolated `.dsh-stage0-magpie-path` profile/state on loopback port 17892 with DSH `0.2.1-rc.3`. Initial watch compiled Host with zero errors and completed the Client bundle. Through authenticated plugin HTTP RPC, detected the exact unquoted Program Files path (real Magpie `0.1.1692`), verified the saved file and enabled the module. Stopped its verified process tree, then restarted the same profile/state with watch disabled and unchanged compiled output. Without sending the path again, detection returned `source: custom` with a newer probe timestamp, the enabled setting survived, a new Magpie Web child used the original executable, and the management snapshot RPC succeeded. A failed replacement probe preserved the saved file; restore-automatic detection subsequently cleared it and returned missing as expected on this isolated environment.
  - Cleanup and handover: Disabled the module and stopped the second Stage0 tree. Confirmed port 17892 free, no owned processes left, and the two pre-existing Magpie processes (PIDs 27376 and 27928, created the previous day) still running. Local `persistence-before.json`, `persistence-after.json`, `persistence-reset.json`, process snapshots and logs remain under the isolated state directory; logs contain local authentication secrets and must not be published. Stage0 is not left running. No commit, push, or other branch update was made.
  - Not verified: This phase's restart evidence is real process/HTTP integration, not browser acceptance. Native Desktop, macOS/Linux execution and a full production/desktop-assistant/H5 build were not exercised. The installation/reset Client behavior is covered by source-level tests.
