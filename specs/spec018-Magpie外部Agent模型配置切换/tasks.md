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

## Verification constraints

- No Magpie setter or current-model command is executed by CodingNS.
- No Gateway, Agent inference, Desktop process, or Desktop profile is started or modified.
- Live Magpie model metadata evidence is read-only; fake fetch remains the test boundary for parser/error cases, usage, and route responses.
