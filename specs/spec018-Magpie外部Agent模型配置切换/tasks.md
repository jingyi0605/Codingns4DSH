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

## Verification constraints

- No Magpie setter or current-model command is executed by CodingNS.
- No Gateway, Agent inference, Desktop process, or Desktop profile is started or modified.
- Live Magpie model metadata evidence is read-only; fake fetch remains the test boundary for parser/error cases, usage, and route responses.
