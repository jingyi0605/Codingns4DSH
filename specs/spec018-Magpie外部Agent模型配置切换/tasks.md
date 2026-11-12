# Tasks: Read-only Magpie model metadata, usage, and route integration

Status: COMPLETE — the read-only Host usage service, subscription display, exact model metadata merge, Codex context correction, and verified Magpie-only Codex model listing are complete.

The former model-switching tasks are intentionally retired. Magpie model selection is supplied by each Agent's ordinary model catalog and is not a CodingNS responsibility.

## Stage 0: Scope decision

- [x] 0.1 Confirm that Magpie switching is out of scope.
  - Status: DONE
  - Decision: Remove the CC-Switch-like selector, setter, read-back, restore, partial-success, and provenance workflow. Keep only catalog recognition, usage display, and route display.
  - Historical evidence: `docs/20261019-MagpieCLI切换可行性验证.md` and `docs/20261020-Magpie模型选择实现与验证.md` remain for traceability and are not current acceptance criteria.

## Stage 1: Read-only Host integration

- [x] 1.1 Keep a strict Magpie catalog reader and version gate.
  - Status: DONE — bounded `magpie --version` and `magpie models <agent>` reads, exact Agent footer/model parsing, loopback origin validation, and short-lived per-Agent caching are implemented.
  - Verify: Focused parser, version, mapping, malformed-output, and cancellation tests.

- [x] 1.2 Remove all configuration-writing and provenance state.
  - Status: DONE — removed Magpie model RPCs, setters, current-model read-back, switch serialization, Client model-source state, session provenance persistence, and switching locale/UI paths.
  - Verify: Repository-wide search finds no Magpie switch RPC or provenance contract/reference in source/tests.

- [x] 1.3 Use direct read-only detection for subscription requests.
  - Status: DONE — the Host calls `MagpieUsageService.read()` for the current session and falls back to the existing Provider subscription service when it returns `null`.
  - Verify: Host RPC test covers route forwarding, Magpie result suppression of ordinary usage, and ordinary fallback.

## Stage 2: Usage and route display

- [x] 2.1 Read and normalize Magpie usage.
  - Status: DONE — aggregate totals, exact Agent/session rows, bounded responses, timeouts, cancellation, and sanitized output are covered by fake API tests.
  - Verify: `tests/magpie-usage.spec.ts`.

- [x] 2.2 Read route details only for a matched Agent session.
  - Status: DONE — route reads require a distinct Provider session ID, exact usage-session match, bounded input, and echoed route-session identity.
  - Verify: Route mismatch, route-null, DSH-session fallback rejection, and unavailable response tests.

- [x] 2.3 Display Magpie usage without changing ordinary usage.
  - Status: DONE — the existing subscription slot renders Magpie aggregate/session/route sections, keeps old direct-provider response compatibility, and preserves ordinary usage fallback.
  - Verify: Usage-slot tests and `pnpm run i18n:check`.

## Stage 3: Verification and documentation

- [x] 3.1 Run focused source tests and project static checks.
  - Status: DONE — focused Host/Client/Magpie tests and project static checks passed.
  - Verify: `node --import ./tests/register-css-loader.mjs --test --test-concurrency=1 tests/magpie-usage.spec.ts tests/cli-adapters.spec.ts tests/cli-adapters-rpc.spec.ts tests/cli-adapters-claude-models.spec.ts tests/cli-slots-translation.spec.ts tests/peer-host-model-navigation.spec.ts tests/client-theme.spec.ts` (250 passed); `pnpm run typecheck`; `pnpm run version:check`; `pnpm run capability:check`; `pnpm run i18n:check` (0 blocking violations); `git diff --check`.
  - Does not do: Start a development server, Gateway, GUI, or DSH Desktop; change real Agent configuration; build, release, or publish.

- [x] 3.2 Record the scope change.
  - Status: DONE — `docs/20261021-Magpie范围调整与代码清理.md` records the removed switching boundary and retained read-only behavior.

- [x] 3.3 Final Spec review.
  - Status: DONE — requirements, design, tasks, README, tests, and the live-read report describe the same read-only behavior; no current source path can switch Magpie configuration.

## Stage 4: Read Magpie model metadata

- [x] 4.1 Add a bounded `/v1/models` reader and normalized metadata contract.
  - Status: DONE — the Host uses the bounded loopback reader and a safe public-field allowlist.
  - What this does: Read Magpie's standard model catalog on the owning Host and normalize only known public model fields.
  - Done when: Tests cover size/time bounds, schema validation, context fields, reasoning levels, token limits, modalities, service tiers, capabilities, and malformed/missing responses.
  - Does not do: Expose raw Gateway records, credentials, or unknown fields; start Magpie or run model inference.
  - Requirements: R6–R8.

- [x] 4.2 Enrich exact Magpie model matches for every verified external Agent other than Codex.
  - Status: DONE — all 15 currently verified external adapter mappings other than Codex are covered by exact-match enrichment tests.
  - What this does: Merge Magpie metadata into existing Agent catalog entries only when both `magpie models <agent>` and `/v1/models` return the same exact ID.
  - Done when: Tests cover every currently verified external adapter mapping except Codex, explicit Command Code ID normalization, no fuzzy matching, and unchanged catalogs when Magpie data is unavailable.
  - Does not do: Add new selection RPCs, restore Magpie switching UI, or modify normal non-Magpie model choices.
  - Requirements: R6, R8.

- [x] 4.3 Correct Codex `auto/gpt-6.1-sol` context before usage stabilization.
  - Status: DONE — trusted Magpie context is applied before stabilization; stale usage is corrected and ratios use 500,000.
  - What this does: Apply the validated Magpie 500,000-token value to the exact model before the first Codex window is anchored, and fix the static fallback.
  - Done when: Tests prove stale `258400` usage cannot win, ratios and compaction use 500,000, and similarly named provider records remain isolated.
  - Requirements: R7–R8.

- [x] 4.4 Verify and record the read-only real-device test.
  - Status: DONE — an already-running local Magpie Gateway returned HTTP 200 from `/v1/models`; 34 records were present, including the exact `auto/gpt-6.1-sol` record with `context_window: 500000`, `max_output_tokens: 128000`, supported reasoning levels, modalities, and service tiers. The current Magpie CLI also returned the exact Codex catalog entry. No Gateway or Agent was started.
  - Done when: The live response is documented without provider credentials, and fake tests cover success and failure cases.
  - Requirements: R6–R8.

## Stage 5: Final metadata verification

- [x] 5.1 Run the focused metadata, Codex, catalog, and existing Magpie usage tests; run relevant static checks.
  - Status: DONE — the focused suite passed 250/250; all listed static checks passed.
  - Verify: Source-loader tests, `pnpm run typecheck`, `pnpm run i18n:check` (0 blocking violations), `pnpm run version:check`, `pnpm run capability:check`, and `git diff --check`.
  - Does not do: Build, start servers, change Magpie/Agent configuration, operate Desktop, release, or publish.

- [x] 5.2 Final Spec review.
  - Status: DONE — requirements, design, tasks, README, tests, and the dated report agree on exact mappings, read-only behavior, metadata precedence, Codex context correction, and Codex model-list additions.

## Stage 6: Show Magpie-only models in the Codex picker

- [x] 6.1 Add validated Magpie Codex IDs missing from the native model list.
  - Status: DONE — Codex's existing model group now includes exact IDs from `magpie models codex` when absent from `model/list`; Gateway metadata is preferred, and the verified CLI label is used when a Gateway row is unavailable.
  - Done when: Focused tests prove native choices and selection stay intact, Magpie-only models appear once by exact ID, and no unverified Agent models are added.
  - Verify: `node --import ./tests/register-source-loader.mjs --test tests/magpie-usage.spec.ts`; `pnpm run typecheck`; `git diff --check`.
  - Does not do: Change Magpie configuration, start Magpie, call model inference, or operate Desktop.
  - Requirements: R9.

- [x] 6.2 Restore provider labels beside Magpie model names.
  - Status: DONE (2026-10-26) — provider IDs are carried independently of model labels and rendered beside the Magpie logo.
  - What to do: Carry the verified provider ID separately from model names and show it in the shared Magpie tag used by external Agent, native DSH, and delegation model menus.
  - Observable result: Equal model names from different providers retain distinct visible provider tags; automatic routes and old Host responses do not invent a carrier.
  - Dependencies: Completed tasks 4.1, 4.2, and 6.1; existing shared Magpie badge and native menu decoration.
  - Read first: R10 in `requirements.md`, design section 5.1, external Agent adapter rules, and frontend localization rules.
  - Files: `src/shared/contracts/cli-adapter.ts`, `src/host/cli-adapters/magpie-usage.ts`, `src/client/magpie-model-tag.ts`, `src/client/cli-slots.ts`, `src/client/native-model-translation-menu.ts`, `src/client/delegate-command.ts`, and their focused source tests.
  - Out of scope: Changing Magpie settings, resolving automatic routes in the picker, changing selection IDs or persistence, building, deploying, or fixing unrelated usage-panel tests.
  - Verification: `node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 --test-skip-pattern='路由卡片标题栏' tests/magpie-usage.spec.ts tests/native-model-magpie-tag.spec.ts tests/cli-slots-translation.spec.ts tests/delegate-ui-dom.spec.ts tests/cli-adapters-codex-magpie-model.spec.ts` passed 95 tests with the known baseline test excluded. The final external model menu test also passed as part of all 16 tests in `tests/cli-slots-translation.spec.ts`.
  - Static checks: `pnpm run typecheck`, `pnpm run version:check`, `pnpm run capability:check`, `pnpm run i18n:check` (0 blocking violations, 201 existing internal-text warnings), and `git diff --check` passed.
  - Broader source checks: `node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/cli-catalog-cache.spec.ts tests/cli-adapters.spec.ts tests/cli-adapters-rpc.spec.ts tests/peer-host-model-navigation.spec.ts tests/contracts.spec.ts` produced 212 passes and four baseline failures. Each failure also reproduces on an isolated archive of untouched `436e1e0`: three Command Code installation/login-shell tests assume non-Windows command shapes, and `Codex MCP mcpToolCall 转换为 DSH 工具生命周期并保留失败结果` fails at `tests/cli-adapters-rpc.spec.ts:173`.
  - Additional baseline finding: The existing `路由卡片标题栏的查看请求按钮复用管理页请求视图并固定当前会话` test fails its `/4\.9M/` assertion because the Chinese locale renders `490万`. This also reproduces on untouched `436e1e0`; it remains unchanged.
  - Stage0 verification (2026-10-26, separately authorized): Reused the dedicated `~/.dsh-stage0-020` profile and its existing repository junction; `pnpm run dev:link stage0` confirmed the link. Started `scripts/run-dsh-stage0.sh` with Git Bash on Windows, using DSH `0.2.1-rc.3`, isolated state `~/.config/codingns4dsh/stage0-020`, and port `17891`. Managed TypeScript/client watchers compiled successfully (0 TypeScript errors; existing ineffective-dynamic-import warning only). Desktop was not changed.
  - Live Stage0 evidence: Authenticated index returned HTTP 200; its actual CodingNS browser asset returned HTTP 200 and contained `magpieProviderId`; the Magpie icon returned HTTP 200. Read-only `cli/models` for Codex returned seven Magpie models with separate `tlp`/`hl` provider IDs, including distinct `tlp/gpt-6.1-sol` and `hl/gpt-6.1-sol` entries with the same display name. Detection reported Magpie `0.1.1358`. No model inference or settings writes were performed by validation.
  - Compiled checks: `node --import ./tests/register-css-loader.mjs --test --test-concurrency=1 tests/native-model-magpie-tag.spec.ts tests/cli-slots-translation.spec.ts` passed 18 tests after Stage0 compilation. Startup logs: `~/.config/codingns4dsh/stage0-020/provider-label-20261026-023433.stdout.log` and matching `.stderr.log`; the direct login URL is printed in stdout and is intentionally not copied into tracked documentation. Restart with `pnpm run dsh:stage0` using Git Bash on PATH; do not start another watcher while this instance owns the port/output.
  - Manual acceptance (2026-10-26): The user confirmed Stage0 verification passed after the carrier font adjustment and authorized committing and opening the upstream PR. This is user-reported acceptance, not an agent-operated browser check; separate coverage of every menu and viewport was not recorded. No Desktop deployment was performed.
  - Typography adjustment (2026-10-26): Increased shared carrier text from 11px to 12px. Both tests in `tests/native-model-magpie-tag.spec.ts` pass with React and imperative font-size assertions; `git diff --check` passes. The existing Stage0 watcher rebuilt the Client successfully, and its generated Magpie tag chunk contains the 12px style. User-reported visual acceptance is recorded above.

## Stage 7: Preserve Claude context variants after metadata enrichment

- [x] 7.1 Fix provider/context labels across Claude discovery and Magpie enrichment.
  - Status: DONE (2026-10-28) — metadata enrichment preserves provider-qualified labels and explicitly distinguishes Claude `[1m]` choices without changing selection IDs.
  - What to do: Prefer provider-qualified Gateway metadata labels and preserve the `[1m]` marker through Claude discovery, enrichment, refresh, and the ordinary model menu.
  - Observable result: Same-name models from different providers and ordinary/long-context variants remain distinguishable, with unchanged selection IDs and efforts.
  - Dependencies: Completed tasks 4.2 and 6.2; existing Claude CLI/Gateway discovery and shared model menu.
  - Read first: Requirement R11, design section 5.2, external Agent adapter rules, and frontend localization rules.
  - Files: `src/host/cli-adapters/claude-model-options.ts`, `src/host/cli-adapters/model-catalog.ts`, `src/host/cli-adapters/magpie-usage.ts`, `tests/cli-adapters-claude-models.spec.ts`, `tests/magpie-usage.spec.ts`, `tests/cli-slots-translation.spec.ts`, and this Spec.
  - Out of scope: Deduplicating different selection IDs, changing context limits/efforts/routing, changing Agent configuration, building, installing into Desktop, publishing, or repairing unrelated baseline failures.
  - Verification: `node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 --test-skip-pattern='路由卡片标题栏' tests/cli-adapters-claude-models.spec.ts tests/magpie-usage.spec.ts tests/cli-slots-translation.spec.ts tests/native-model-magpie-tag.spec.ts tests/cli-adapters-codex-magpie-model.spec.ts tests/cli-catalog-cache.spec.ts` passed 105 tests, with the known route-card baseline test explicitly excluded. Coverage includes normal/long-context and cross-provider choices, configured model fallback, unavailable metadata, repeat enrichment, preserved efforts, and menu selection payloads.
  - Static checks: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`, `node scripts/check-version-sync.mjs`, `node scripts/check-capability-retirement.mjs`, `node scripts/check-client-i18n.mjs` (0 blocking violations, 201 existing internal-text warnings), and `git diff --check` passed. These execute the existing package-script entry points directly, avoiding the machine's pnpm dependency auto-sync/no-TTY removal failure observed earlier in the session.
  - Regression evidence: Before the fix, both new discovery/enrichment and metadata-parser tests failed because `Claude Sonnet 5.5 · hl` was overwritten with `Claude Sonnet 5.5`. The first post-fix run passed the new cases; the existing route-card `/4\.9M/` expectation still fails against Chinese `490万`, as already recorded under task 6.2.
  - Stage0 verification (2026-10-28, separately authorized): Reused the existing DSH `0.2.1-rc.3` runtime on `http://127.0.0.1:17891`, home `~/.dsh-stage0-020`, state `~/.config/codingns4dsh/stage0-020`, and the existing managed compilation watchers. `node scripts/link-dsh-dev.mjs stage0` confirmed the repository junction. No second watcher, rebuild/clean command, server restart, or Desktop profile change was needed. The generated Host modules contain the fix and the live Host returns it through RPC.
  - Live Host evidence: Authenticated login returned HTTP 303 and the index HTTP 200. `POST /codingns/cli/models` with `{ "type": "client-request", "rpcId": "<fresh UUID>", "method": "cli/models", "payload": { "adapterId": "claude-code" } }` returned HTTP 200 with `result.ok: true`. It retained both `hl/claude-sonnet-5-5` and `hl/claude-sonnet-5-5[1m]`, labelled `Claude Sonnet 5.5 · hl` and `Claude Sonnet 5.5 · hl [1m]`; both Opus variants likewise have distinct labels. The `tlp` and `hl` GPT routes remain independent. Assertions confirmed exactly one `[1m]` marker for each long-context selection.
  - Client resource evidence: The index's exact combined preload URL, including its `rev` parameter, returned HTTP 200 and contained `magpieProviderId`; the Magpie icon at `/api/codingns/provider-icons/magpie.png` returned HTTP 200. An initially derived single-entry URL without the revision returned HTTP 404; the successful check uses the actual index-advertised URL instead. Resource delivery does not establish browser rendering.
  - Compiled regressions: `node --import ./tests/register-css-loader.mjs --test --test-concurrency=1 tests/cli-adapters-claude-models.spec.ts tests/cli-slots-translation.spec.ts tests/native-model-magpie-tag.spec.ts` passed 31 tests against the current watcher-generated output.
  - Continuation: Stage0 is shut down after final user acceptance (see task 7.2). Initial startup logs are `~/.config/codingns4dsh/stage0-020/provider-label-20261026-023433.stdout.log` and matching `.stderr.log`; the stdout log contains a private direct-login URL, which is not copied into tracked notes. For a future authorized run, start `scripts/run-dsh-stage0.sh` with Git Bash after inspecting port 17891 and watcher ownership.
  - Remaining verification: Separate coverage of every menu/viewport and release build/package checks remains pending. No inference request, Agent configuration write, or Desktop installation change was performed. The source fix is on `fix/claude-model-labels`, based on main `4cdeb69`.
  - User acceptance (2026-10-28): The user reported that the labels display correctly in Stage0 and requested a follow-up ordering improvement. This accepts the observed menu-label fix, not every viewport or the subsequent sorting change.

- [x] 7.2 Sort the Claude conversation model menu.
  - Status: DONE (2026-10-28) — presentation-only ordering keeps aliases first and related model/provider/context choices adjacent.
  - What to do: Pin the default/shortcut aliases including CLI-discovered Fable, then sort by provider, model name, and ordinary before `[1m]` while preserving the existing search flow.
  - Observable result: Related provider/context variants appear together in a deterministic natural order without changing selection IDs or other Agents' menu order.
  - Dependencies: Task 7.1 and the existing conversation model menu and search tests.
  - Read first: Requirement R11.6, design section 5.2, and frontend localization rules.
  - Files: `src/client/cli-slots.ts`, `tests/cli-slots-translation.spec.ts`, and this Spec.
  - Out of scope: Host catalog/default-model changes, sorting other Agent menus, new settings, inference, Desktop deployment, or release publishing.
  - Verification: The new shuffled-catalog test failed before implementation. `node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/cli-slots-translation.spec.ts tests/native-model-magpie-tag.spec.ts tests/cli-adapters-claude-models.spec.ts` passed 32 tests, including frozen input-catalog immutability, unchanged Codex ordering, natural numeric ordering, pinned aliases, search behavior, and exact selection payloads. The same command with `register-css-loader.mjs` passed 32 compiled tests.
  - Static checks: The existing typecheck, version, capability, localization (`--json`), and diff-check entry points all exited 0; no new locale keys or dependencies were needed.
  - Stage0 delivery: The initial live Client still served revision `52980e1200da` without the comparator despite updated on-disk bundles. The user explicitly approved restarting Stage0. Only the verified Stage0 supervisor/server descendant tree was stopped; Desktop was untouched. The first restart encountered pnpm's dependency auto-sync/no-TTY failure. A process-scoped `pnpm_config_verify_deps_before_run=false` allowed the installed compilers to run without reinstalling dependencies or changing repository package-manager configuration. `pnpm exec tsc --version` returned 5.9.3 before the successful restart.
  - Initial sorting runtime: Started with Git Bash `scripts/run-dsh-stage0.sh`, the existing isolated home/state/profile, and managed compilation watchers. The initial compilation succeeded; PID 35464 owned port 17891 before the provider-first follow-up restart. Authenticated index and its exact Client preload URL both returned HTTP 200; the served Client revision was `be7e5cbe7a25` and contained the natural-sort comparator (`ignorePunctuation`). Logs are `~/.config/codingns4dsh/stage0-020/claude-model-sort-20261028-005526.stdout.log` and matching `.stderr.log`. The stdout log contains a private direct-login URL; do not copy its token into tracked notes.
  - Remaining verification: Release build/package checks and exhaustive viewport coverage were not performed. No inference request or Desktop deployment was performed.
  - Follow-up (2026-10-28): The user reported that the default Fable entry appeared below channel models and requested provider-first ordering. Live Stage0 `cli/models` confirmed the CLI-discovered ID is `fable` (label `Fable`, with no provider), distinct from `hl/claude-fable-5-1`. The pin list now includes only the existing discovered Fable alias, and channel comparison precedes model-name comparison. The shuffled-catalog regression includes Fable and a cross-channel order that failed under the prior comparator. The same three focused source and compiled suites each passed 32 tests; typecheck, version, capability, localization, and diff checks passed.
  - Follow-up Stage0 delivery: The previous process still served the old cached Client despite the successful watcher build. Restarted the task-owned isolated Stage0 process tree using the existing Git Bash launcher and process-scoped pnpm override; no unrelated or Desktop processes were stopped. The new managed compilation succeeded, PID 33408 owned port 17891, and authenticated index/Client resource requests returned HTTP 200. The actual served revision `26aca4c5faf5` contained the pinned `fable` alias and provider-before-name comparator (asserted from the served bundle). Latest logs: `~/.config/codingns4dsh/stage0-020/claude-provider-sort-20261028-011344.stdout.log` and matching `.stderr.log`; the private direct-login URL stays in that local log.
  - Final user acceptance and shutdown (2026-10-28): The user confirmed verification passed for the corrected label/ordering behavior and authorized shutdown, a Chinese-language commit, and an upstream PR. Stopped the verified Stage0 supervisor/server tree, including managed TypeScript/Client watchers. Port 17891 has no listener and no repository Stage0/watch processes remain. Retained isolated profiles/state/logs for reproduction; Desktop was not stopped or modified. This is user-reported visual acceptance, separate from the agent's HTTP/RPC/resource checks.
  - Pre-submission verification: Re-ran the six focused source suites listed in task 7.1 after the final Fable/provider-first change: 106 passed, 0 failed, with the same known route-card baseline test explicitly excluded by `--test-skip-pattern='路由卡片标题栏'`. Final `git diff --check` passed. The latest compiled subset remains 32/32 as recorded above; no release build/full-suite claim is made.

## Antigravity Magpie environment repair — 2026-11-03

- Reuse the Host-detected Magpie executable for bounded `magpie agy env` reads during AGY model discovery and each turn. Keep credentials in the child environment, preserve explicit selections, and normalize AGY's native `magpie/` prefix only for verified metadata matching.
- Restored repository dependencies using `pnpm install --frozen-lockfile`; the installed DSH packages had been `0.2.1-alpha.2`, while the manifest and lockfile require `0.2.1-rc.5`. Neither manifest nor lockfile changed. The previous `UserTextRule` type errors disappeared after this restoration.
- `pnpm build` passed, including TypeScript, Client, and H5 bundling. The four targeted suites with `--test-name-pattern='Antigravity|Magpie metadata enriches exact model matches'` passed 34 tests through `tests/register-source-loader.mjs`. Direct compiled Antigravity tests passed 33 tests; the source-importing Magpie suite requires the source loader and cannot be run directly as a compiled test.
- User explicitly authorized building and live Stage0 verification. Installed DSH `0.2.1-rc.5` with pnpm `10.7.1` into the separate local runtime directory; retained the independent Stage0 Home `~/.dsh-stage0-020` and source link. Backed up the Windows Stage0 launcher and changed only its runtime path to `rc.5`. No Desktop profile or process was changed.
- Started Stage0 at `http://127.0.0.1:17891/` after the complete build, with the compiler watcher disabled for this run. Authenticated index returned HTTP 200. Real `cli/catalog/refresh` detected AGY `1.4.12`; real `cli/models` returned all eight exact `magpie/…` entries with source markers, names, and efforts, and repeated reads preserved the catalog.
- Real DSH session `session-f593d6b3-73dd-4db8-806c-0bab142cbed5` used `magpie/hl/gpt-6.1-sol`, effort `low`, translation off. Both turns returned their requested unique markers with `turn/end.reason.kind=completed`, no error events, and the same AGY provider session ID, proving first-turn startup and resumption through the plugin.
- Local evidence: `~/.config/codingns4dsh/stage0-020/antigravity-result.json`, `antigravity-verification-run.json`, and the referenced stdout/stderr logs. The stdout log contains a private login token; do not copy it into tracked notes. The test session and its recent Antigravity model preference remain in Stage0. A generic `settings/set` preference-restoration attempt was rejected with `CODINGNS_SETTINGS_FIELD_FORBIDDEN`; no permissions or settings boundary was changed to bypass that rejection.
- Stage0 remains running for user inspection. No actual browser interaction, default-model inference, other-model inference, online cancellation, or full-suite regression was performed in this live validation.
- Separate observed runtime issue: the enabled `credentials` feature reports `CREDENTIAL_BROKER_UNAVAILABLE` during activation. Its cause was not investigated in this Antigravity repair; both real Magpie turns completed despite this failure. Do not interpret this acceptance as verification of the credential-broker feature.

## Antigravity conversation model ordering — 2026-11-03

- Apply the existing Claude conversation-menu ordering to Antigravity: keep `provider-default` first, then compare provider and model name using the same natural collator. Preserve model IDs, efforts, native AGY entries, and the cached Host catalog; other adapters retain their existing behavior.
- The shuffled-catalog regression covers provider/name ordering, frozen input-array immutability, and the exact selected Magpie ID submitted through `cli/session/set`. `node --import ./tests/register-source-loader.mjs --test tests/cli-slots-translation.spec.ts` passed all 21 tests, including the existing Claude ordering, Codex ordering, and search cases.
- `pnpm run typecheck`, `pnpm run i18n:check`, and `pnpm build` passed. Localization reported 0 blocking violations and 125 existing internal-text warnings; the build retained the existing nonblocking ineffective-dynamic-import warning.
- Restarted only the task-owned isolated Stage0 after the build. Authenticated login returned HTTP 303 and the index HTTP 200. The index-advertised combined Client resource at revision `e5684352b530` returned HTTP 200 and contained both `compareAntigravityModelOptions` and the shared provider/name comparator. Local launcher/log references are in `~/.config/codingns4dsh/stage0-020/antigravity-sort-run.json`; keep the private login token out of tracked notes.
- Stage0 remains running for inspection at `http://127.0.0.1:17891/`. Menu behavior is covered by the hook-render tests; actual browser clicks and viewport rendering were not verified. No additional inference, Desktop deployment, commit, or push was performed for this ordering follow-up.

## Antigravity native/Magpie source distinction — 2026-11-03

- Live Stage0 showed native `gemini-3.8-flash` / `gemini-4-argon` and explicit `magpie/tlp/…` choices carrying identical Magpie names and provider badges. The generic unique-display-name matcher incorrectly treated the native choices as Magpie aliases and also overwrote their public metadata. The user chose to retain both sources rather than hide the native choices.
- AGY now requires an exact Magpie catalog ID after its documented prefix normalization. Same-name native models keep their original names, efforts, and metadata. The conversation picker adds a localized `Antigravity 原生` / `Native Antigravity` suffix to native names and tooltips, including the selected-model label. Explicit Magpie choices retain their verified provider names and badges. Model IDs, both sources, and the previous provider/name ordering remain intact.
- The new metadata regression failed before the fix, demonstrating the native model's overwritten name, efforts, provider, and context. After the fix, the four source suites `tests/magpie-usage.spec.ts`, `tests/cli-slots-translation.spec.ts`, `tests/cli-adapters-antigravity.spec.ts`, and `tests/cli-adapters-antigravity-usage.spec.ts` passed with `--test-concurrency=1 --test-skip-pattern='路由卡片标题栏'`. The existing unrelated route-card localization test remains explicitly excluded as documented under task 7.1. New coverage includes native-only and mixed catalogs, both Gemini versions, unmodified native objects, exact route selection, visible source labels, and provider badges.
- Version, capability-retirement, localization, and diff checks passed. `pnpm build` passed, including TypeScript and Client/H5 bundles; the existing nonblocking dynamic-import warning remains.
- Restarted only the verified isolated Stage0 runtime and its task-owned launcher processes. Authenticated index, real `cli/models`, and the exact index-advertised Client resource each returned HTTP 200. All 14 prior model IDs remain available (upstream enumeration order changed across starts); exactly 8 explicit Magpie models retain the Magpie source marker. Both native Gemini entries have their original labels and efforts with no Magpie source/provider fields. Served Client revision `7669f370e102` includes the new bilingual native-source label.
- Local evidence is `~/.config/codingns4dsh/stage0-020/antigravity-source-label-result.json`; launcher/log references are in `antigravity-source-label-run.json`. The verification script and evidence contain no login token. Stage0 remains available for user inspection. Browser interaction and inference through the native Gemini choices were not performed; no Desktop deployment, commit, or push was performed.
- Label follow-up: At the user's request, both locales now use only `{name} · Antigravity`, without the native qualifier. The 22 conversation-menu tests, localization check, and Client bundle build passed. The running Stage0 advertised Client revision `effc328cb977`; its resource returned HTTP 200 with the short label and neither old qualifier. No restart was needed; browser visual verification remains separate.

## 上游同步与提交前验证 — 2026-11-03

- 当前分支已快进至上游 `main` 的 `69307539`，保留全部 Antigravity 修复，没有合并冲突。上游基线为插件 `0.2.2-beta.1`、DSH 测试依赖 `0.2.2-alpha.2`。执行 `pnpm install --frozen-lockfile` 对齐本机依赖，未修改 `package.json` 或 `pnpm-lock.yaml`。
- 新基线上的 `pnpm build` 通过，包含 TypeScript、Client 和 H5 构建；版本、能力退休、国际化和 `git diff --check` 检查通过。国际化为 0 个阻断、125 个既有内部文案警告。
- 未排除用例，执行源码加载器下的七个定向测试文件：`cli-adapters-antigravity.spec.ts`、`cli-adapters-antigravity-usage.spec.ts`、`magpie-usage.spec.ts`、`cli-slots-translation.spec.ts`、`cli-adapters-claude-models.spec.ts`、`native-model-magpie-tag.spec.ts`、`cli-catalog-cache.spec.ts`。共 144 项，143 项通过；唯一失败仍为任务 7.1 已记录的路由卡片断言：期望英文 `4.9M`，实际中文为 `490万`。本次未修改该断言或相关视图，也未将此轮报告为全通过。
- 对新构建产物直接执行两个 Antigravity 测试文件，共 33 项全部通过。新基线没有重新运行完整测试集或真实 Stage0 推理；前述真实两轮验证属于 DSH `0.2.1-rc.5`，不代表已验证 `0.2.2-alpha.2` 的浏览器或真实 CLI 路径。
- 提交前已关闭本次任务创建的旧版隔离 Stage0 及其启动器，确认 17891 端口释放，避免混用新依赖与旧运行时。Desktop 未变更。同步前的本地补丁和 stash 备份保留，未清理其他分支、工作区或既有备份。

## Antigravity settings 透传修复 — 2026-11-12

- 本机 AGY `1.5.6` 与选定 Magpie `0.1.3820` 下复现：只传 API 环境变量的 `agy models` 退出 1 并要求登录；加入 `magpie agy env` 返回的 `settings` 后目录恢复。`--settings` 必须置于 `models` 之前，置后会报未知参数。Desktop 已安装的插件 `0.2.2-rc.2` 保留旧环境修复，但尚未透传 `settings`。
- 适配器接受可选 `settings`，用于目录探测及每轮（含续接）启动；保持显式模型、Host 环境覆盖、取消和旧版无 `settings` 行为。只传给 CLI，不读取或持久化文件内容，不返回 Client。修复前，两项更新后的行为测试失败；修复后通过。
- 真实源码驱动调用本机 CLI，返回非回退目录共 13 项：默认项、5 个合并思考档位后的原生模型及 7 个 Magpie 模型。未进行真实模型推理或浏览器交互。
- `pnpm run typecheck`、`pnpm run version:check`、`pnpm run capability:check`、`git diff --check` 通过。Windows 使用既有 DSH `0.2.2-rc.1` runtime 中的 pnpm 入口，未安装依赖或改写锁文件。
- 源码加载器执行 `cli-adapters-antigravity.spec.ts`、`cli-adapters-antigravity-usage.spec.ts`、`cli-catalog-cache.spec.ts`、`cli-slots-translation.spec.ts`，66 项通过；加入 `magpie-usage.spec.ts` 和 `native-model-magpie-tag.spec.ts` 后为 137 项通过、1 项失败，失败为前述 `4.9M` / `490万` 断言。
- 按适配器规则执行全部 `cli-adapters*.spec.ts`、`cli-catalog-cache.spec.ts`、`external-agent-pr.spec.ts`（源码加载器，串行），682 项通过、24 项失败、7 项跳过。将本次唯一修改的生产模块在内存加载时替换为 HEAD 版本，重跑这 24 项及上述 Magpie 失败项，25 项均复现失败；临时加载器已删除。日志保留于系统临时目录的 `codingns-antigravity-adapter-20261112.log` 和 `codingns-antigravity-baseline-20261112.log`。
- 本次没有构建、部署、重启既有服务、提交或推送。桌面生效仍需另行构建并更新安装包，再重新检测目录；当前验证不代表桌面 UI 或真实推理已通过。
- 按用户要求，将修复完整迁移至从本地 `main`（`63ac83e6`）创建的 `fix/antigravity-magpie-settings` 分支，独立工作树为 `D:/develop/Codingns4DSH-antigravity-settings`。原 `feat/native-agent-compact` 工作树已还原本次五个文件的修改，分支提交不变。在新分支重新执行上述四个定向测试文件，66 项通过；类型检查通过；真实源码驱动仍返回非回退的 13 项目录。前述扩大回归和 HEAD 对照结果来自迁移前的 `d4bcbf3f` 基线，没有将其记为新 `main` 基线的全量验证。

### 独立 Stage0 实机验收 — 2026-11-12

- 用户随后授权部署 Stage0。新工作树执行 `pnpm.cmd run build` 通过（先将既有 runtime 的 pnpm 目录加入本次子进程 PATH；初次未设置 PATH 的构建在 prebuild 阶段退出，未生成产物）。使用 DSH `0.2.2-rc.1`，新建 Home `C:/Users/Administrator/.dsh-stage0-antigravity-settings`、本机验证目录 `~/.config/codingns4dsh/stage0-antigravity-settings`，监听 `127.0.0.1:17904`。Profile 仅链接本修复工作树；以 `DSH_STAGE0_WATCH=0` 启动已构建产物，TMPDIR 指向该独立 Home 的 tmp。没有复制 Desktop 凭据、修改 Desktop 安装或重启其他进程。
- 通过真实 `magpie/management/detection` RPC 选择本机 Magpie `0.1.3820` 入口，`cli/catalog/refresh` 检测到 AGY `1.5.6`。`cli/models` 返回非回退目录 13 项（默认项、5 个原生模型、7 个 Magpie 模型），包含正确的来源和模型元数据；重复读取保持完整。
- 原生接口创建验收工作区与会话 `session-7b152988-00c3-4781-aeb4-04f4a893031d`，选择 `magpie/hl/gpt-6.1-sol` 后发送两轮无工具请求。两轮均 completed，真实回复分别含 `AGY_SETTINGS_STAGE0_ROUND_1_OK` 和 `AGY_SETTINGS_STAGE0_ROUND_2_OK`；Provider 会话标识均为 `8850ad3c-5011-47f9-9dae-f1fd9e40aed0`，确认真实续接。
- 用仓库现有 Chrome headless 测试驱动打开真实页面：模型菜单 13 项均未禁用，原生 `Gemini 4 Argon · Antigravity` 与 Magpie 同名项可区分；实际点击原生 Gemini 和 Magpie GPT 两个选项，Host 回读精确模型 ID 正确，分别整页刷新后所选模型仍保持。基础目录与 Magpie 元数据分阶段加载，验收脚本等待完整标签后断言。页面可见两轮真实回复，已保存菜单与对话截图。此处原生模型只验证选择和持久化，未发送原生 Gemini 推理请求。
- 首页和实际 Client 资源 HTTP 200，Client revision 为 `219e50216dd6`。证据包括本机目录中的 `verification.json`、`catalog.json`、`acceptance.json`、`browser-verification.json`、`acceptance-model-menu-final.png`、`acceptance-conversation.png`；启动器和进程信息为 `start.ps1`、`run.json`。认证链接仅保留于本机日志和 `.url` 快捷方式，不写入仓库。
- Stage0 保持运行供用户验收，会话标题为“验收通过：Antigravity 模型选择与两轮续聊”。原工作树仍干净；未提交、推送或更新 Desktop。后续修改源码需要重建并只重启本次隔离实例。
- 用户随后确认验收通过，并授权关闭环境、提交和向上游发起 PR。已核对本轮启动器、托管器和服务进程身份并关闭，确认 `17904` 不再监听，既有 `17890`、`17897` 服务保留。验收数据、截图和启动配置保留在本机独立目录，认证链接在服务关闭后不再可用。

## Verification constraints

- No Magpie setter or current-model command is executed by CodingNS.
- Fixture verification does not start or modify a Gateway, Agent inference, Desktop process, or Desktop profile. The separately user-authorized live Stage0 exception and its actual scope are recorded above.
- Live Magpie model metadata evidence is read-only; fake fetch remains the test boundary for parser/error cases, usage, and route responses.
