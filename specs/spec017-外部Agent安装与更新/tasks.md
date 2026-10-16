# Tasks: External Agent installation and updates

Status: DONE — terminal progress, result feedback, and automatic list refresh verified

- [x] 1. Verify official methods (DONE)
  - Work: inspect all registered adapters and official install/update sources.
  - Result: a source-linked platform/method matrix.
  - Dependencies: none.
  - Read: requirements R1–R2; design §1–2; adapter development rules.
  - Files: `docs/调查报告/20261016-外部Agent官方安装与更新方式.md`; Host method catalog.
  - Excludes: executing installers or changing protocol drivers.
  - Verify: source links and all 18 adapter IDs, with explicit manual fallbacks.
- [x] 2. Implement Host execution (DONE)
  - Work: add plans, bounded jobs, registry locks, status/cancel RPCs, and disposal.
  - Result: reviewed commands execute once and return detected results.
  - Dependencies: task 1.
  - Read: requirements R2–R3; design §2–3 and §5.
  - Files: shared management contracts; CLI management service, registry, feature; RPC route list.
  - Excludes: new DSH capability, privilege escalation, remote management.
  - Verify: fake-runner tests for validation, lifecycle, races, and result reporting.
- [x] 3. Implement settings UI (DONE)
  - Work: add state-dependent buttons, method preview, progress, cancellation, and translations.
  - Result: local settings expose installation/update actions and refresh the catalog.
  - Dependencies: task 2.
  - Read: requirements R1 and R3; design §4; settings form rules.
  - Files: CLI settings panel, management dialog, locale fragment, scoped RPC.
  - Excludes: redesigning settings, remote writes, changing enablement preferences.
  - Verify: rendering/state tests and Host routing regressions.
- [x] 4. Verify and record evidence (DONE)
  - Work: run source-based regression tests and required static checks, review the diff.
  - Result: recorded commands, results, and limitations.
  - Dependencies: tasks 1–3.
  - Read: all Spec documents; design §6.
  - Files: relevant tests and this task list.
  - Excludes: builds, servers, actual installs, Desktop operations, commits, and releases.
  - Verify: typecheck, version check, capability check, i18n check, targeted CLI tests.

## Verification evidence (2026-10-16)

The following results cover the initial install/update implementation. Follow-up checks are recorded separately below.

| Check | Result |
| --- | --- |
| `pnpm run typecheck` | Passed after implementation and final fixes |
| `pnpm run version:check` | Passed; version remains 0.2.1-beta.12 |
| `pnpm run capability:check` | Passed; no expired or newly invalid routes |
| `pnpm run i18n:check` | Passed; zero blocking violations; 200 existing internal-log/error warnings |
| `git diff --check` | Passed |
| Management and settings Host tests (command below) | 22 passed, zero failures |
| CLI, catalog, feature wiring, and PeerHost regressions (command below) | 627 tests: 618 passed, 9 platform/live tests skipped, zero failures |

```bash
node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/cli-management*.spec.ts tests/cli-settings-peer-host.spec.ts
node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/cli-adapters*.spec.ts tests/cli-catalog-cache.spec.ts tests/external-agent-pr.spec.ts tests/client-cli-sessions.spec.ts tests/peer-host-model-navigation.spec.ts tests/peer-host-http-proxy.spec.ts tests/feature-wiring.spec.ts
```

The new tests exercise official-method coverage, platform exclusions, command injection rejection, stale plans, detection errors, duplicate submissions, active normal/native-subagent turns, process launch failure, output limits/redaction, cancellation, timeout, disposal, result verification, local RPC scope, remote-route rejection, dialog method selection, progress recovery, and Host switching. A controlled Node subprocess verifies the process runner's output, exit status, and cancellation; it does not run an Agent or installer.

Final review corrected terminal-state reporting to wait for post-command detection, prevented double-click submissions, required a fresh preview when starting another operation, and excluded Homebrew casks on Linux.

## Delivery boundaries

- No build, development server, live installer, live Agent session, or Desktop operation was performed. Browser appearance and real Windows execution were not exercised; UI behavior was tested through the existing hook renderer.
- The 9 skipped regression tests require native Windows or explicitly enabled live Agent fixtures.
- Official commands are source-verified; package installation and compatibility with future Agent releases are not claimed to have been tested live.
- Kimi/Pi migration notes are visible. Manual desktop/interactive/platform methods link to official guidance. No automatic migration, authentication, uninstall, or privilege escalation is added.
- Operation state is kept in Host memory and is recovered when reopening the dialog in the same Host lifetime; it is not persisted across Host restarts.
- Existing Spec016/Quick Apps workspace changes were preserved. No commit, push, release, or publication was made.

## Follow-up: release checks and compact mobile settings

- [x] 5. Verify publisher release feeds and implement a bounded background checker.
  - Refresh checks installed Agents without awaiting network results or taking an execution lock.
  - Ordinary catalog reads are cache-only; unavailable or failed comparisons never expose Update.
  - Preserve prerelease/build identifiers and keep separate legacy distributions conservative.
- [x] 6. Flatten Agent rows and replace Install/Update text buttons with accessible icon actions.
  - Compact Host selector/count, smaller logos, inline versions, no outer card or redundant enablement text.
  - Responsive spacing and narrow-panel fallback retain keyboard focus and touch controls.
- [x] 7. Verify refresh routing, asynchronous progress, release comparisons, mobile structure, and existing CLI behavior.
  - Use fake HTTP responses and the source test loader; no real installers, servers, rendering scripts, or Desktop operations.

### Follow-up verification (2026-10-16)

| Check | Result |
| --- | --- |
| Source-based CLI and integration regressions, command below | 722 tests: 712 passed, 10 platform/live tests skipped, zero failures |
| `pnpm run typecheck` | Passed |
| `pnpm run version:check` | Passed; version remains 0.2.1-beta.12 |
| `pnpm run capability:check` | Passed |
| `pnpm run i18n:check` | Passed; zero blocking violations, 200 existing warnings |
| `git diff --check` | Passed |

```bash
node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/cli-*.spec.ts tests/external-agent-pr.spec.ts tests/client-cli-sessions.spec.ts tests/peer-host-model-navigation.spec.ts tests/peer-host-http-proxy.spec.ts tests/feature-wiring.spec.ts
```

New coverage verifies semantic version/prerelease ordering, Cursor dated builds, official feed selection, no network requests during list loading, immediate refresh responses, three-request concurrency, coalescing, retry, bounded metadata, timeouts, disposal, changed installations, late responses, polling completion, Host routing, icon accessibility, flattened rows, and Update visibility across checking/current/error/unavailable/available states. Version detection now retains prerelease and build suffixes so comparisons do not lose release identity.

Mobile structure and control behavior were tested using the existing hook renderer; live browser appearance was not exercised. No build, development server, live installer, or Desktop operation was performed. Unrelated Spec016/Quick Apps workspace changes remain intact.

## Follow-up: independent modal and live release audit

- [x] 8. Verify every publisher release source and compare the screenshot's installed versions.
  - All 15 configured CLI feeds returned HTTP 200; the real checker reported all seven visible installed versions as updateable.
  - ZCode, WorkBuddy, and Doubao remain explicit manual checks where runtime/application versions cannot be safely compared.
  - Evidence: `docs/调查报告/20261016-外部Agent版本逐项核验与运行态差异.md`.
  - Stage0 process/build timestamps suggest an older loaded Host; no unauthorized restart was performed.
- [x] 9. Move management into a native top-layer modal with one settings entry.
  - Wide desktop layout, full-screen mobile layout, nested modal focus isolation, and collapsed delegation settings.
  - Install is blue and Update is green; both use the refresh button's transparent style.
- [x] 10. Expose unchecked/error/manual states and distinguish Hosts without update-check support.
- [x] 11. Run source tests and required static checks, and record verification.

### Modal and release-audit verification (2026-10-16)

| Check | Result |
| --- | --- |
| Source-based CLI and integration regressions, same command as above | 724 tests: 714 passed, 10 platform/live tests skipped, zero failures |
| Final `tests/cli-update-check.spec.ts` run after invalid-response classification fix | 9 passed, zero failures |
| `pnpm run typecheck` | Passed after the final code change |
| `pnpm run version:check` | Passed; version remains 0.2.1-beta.12 |
| `pnpm run capability:check` | Passed |
| `pnpm run i18n:check` | Passed; zero blocking violations, 200 existing warnings |
| `git diff --check` | Passed |
| Live publisher metadata audit | All 15 configured CLI feeds returned HTTP 200 and parsed successfully |
| Real checker with screenshot versions | All seven visible installed versions reached `available` |

New coverage verifies the single settings entry, lazy dialog content, native dialog cancellation isolation, refresh-style action icons, missing Host support, explicit unchecked state, and bounded failure classifications including valid JSON with an invalid release shape.

ZCode, WorkBuddy, and Doubao require manual application checks because no safely comparable runtime feed was verified. The running Stage0 process predates the Host build artifacts; this suggests stale loaded Host code, but the unauthenticated catalog request returned HTTP 401, so its exact payload was not observed. No server was restarted. No build, live installer, browser rendering, or Desktop operation was performed. Unrelated workspace changes were preserved.

## Follow-up: delegation placement and direct updates

The user restarted Stage0 and confirmed release checks work normally. The user then requested that only the Agent list remain in the modal and that routine updates avoid unnecessary method selection.

- [x] 12. Restore delegation enablement and concurrency to the settings page above the Agent-list entry.
  - Preserve settings writes, input normalization, disabled/read-only behavior, and lazy list loading.
  - Keep delegation controls outside the modal for both local and remote Agent lists.
- [x] 13. Start identified official updates directly from the Update icon.
  - Resolve the installed executable and symlinks; retain recognized npm prefixes and Homebrew ownership.
  - Use official self-updaters where applicable. The initial choice fallback was superseded by the automatic ownership follow-up below.
  - Show progress/cancellation, with command details collapsed. Do not automatically resubmit on status retries, another active operation, or reopening a completed target.
  - Revalidate the installation and fingerprint on the Host before execution.
- [x] 14. Verify settings placement, method resolution, operation recovery, and CLI regressions.

### Direct-update verification (2026-10-16)

| Check | Result |
| --- | --- |
| Source-based CLI and integration regressions, same broad command as above | 729 tests: 719 passed, 10 platform/live tests skipped, zero failures |
| Final management, management UI, and settings tests after completed-target recovery | 32 passed, zero failures |
| `pnpm run typecheck` | Passed after the final code change |
| `pnpm run version:check` | Passed; version remains 0.2.1-beta.12 |
| `pnpm run capability:check` | Passed |
| `pnpm run i18n:check` | Passed; zero blocking violations, 200 existing warnings |
| `git diff --check` | Passed |

```bash
node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/cli-management.spec.ts tests/cli-management-ui.spec.ts tests/cli-settings-peer-host.spec.ts
```

New tests cover direct update dispatch, package-prefix preservation, ownership changes between planning and execution, migration/manual fallbacks, duplicate requests, failed-start status retries, another active operation, recovering a completed target, closing during detection, and delegation edits without loading the list. The existing activity-lock test now waits for its fake runner explicitly because command resolution introduces asynchronous filesystem reads.

Verification used fake updaters and the existing hook renderer. No actual Agent update, build, development-server operation, or Desktop operation was performed by the development agent. Live browser appearance was not exercised. Existing unrelated workspace changes remain intact. Current Host code must be loaded through the user's Stage0 reload workflow.

## Follow-up: terminal output and automatic list refresh

- [x] 15. Present updater output as a scrolling terminal and clarify operation results.
  - Dark monospace viewport, live/result label, empty-output state, automatic following, and jump-to-latest after manual scrolling.
  - Running/success/failure/cancelled panels use icons and text as well as color; failure details and detected versions stay visible.
  - Successful operations offer Close without redundant re-detect or another-operation prompts.
- [x] 16. Refresh the Agent list automatically after successful installation or update.
  - Apply the Host-verified version immediately, clear stale update availability, and call the existing refresh endpoint for that Agent with background release checking.
  - Refresh failures preserve the success result and offer a refresh-only retry.
  - Closing only the progress dialog keeps the monitor active while the list remains open. Transient status errors retry; changing Hosts or unmounting stops monitoring and rejects late responses.
- [x] 17. Verify terminal behavior, result states, refresh routing, background completion, and existing management behavior.

### Terminal and refresh verification (2026-10-16)

| Check | Result |
| --- | --- |
| Focused source regressions, command below | 48 passed, zero failures or skips |
| `pnpm run typecheck` | Passed after the final code change |
| `pnpm run version:check` | Passed; version remains 0.2.1-beta.12 |
| `pnpm run capability:check` | Passed |
| `pnpm run i18n:check` | Passed; zero blocking violations, 200 existing warnings |
| `git diff --check` | Passed |

```bash
node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/cli-management.spec.ts tests/cli-management-ui.spec.ts tests/cli-settings-peer-host.spec.ts tests/cli-update-check.spec.ts
```

New tests verify automatic scrolling and pausing, rendering output as text, result icons and labels, one refresh per completion, immediate verified versions, local refresh routing, stale-response isolation across Hosts, refresh-only retries, hidden-dialog completion, and recovery from transient status failures. Tests use fake updaters, the hook renderer, and a controlled scroll viewport. No live browser rendering, actual Agent update, build, server operation, or Desktop operation was performed. This follow-up changes Client code only; existing unrelated workspace work remains intact.

## Follow-up: duplicate rows and automatic ownership

- [x] 18. Fix the React key collision between Agent rows and their management dialog.
  - A regression reproduced duplicate sibling keys before the fix and passes after namespacing the dialog key.
  - Cover repeated opening, catalog refresh, hidden progress, and closing without adding catalog de-duplication state.
- [x] 19. Remove the installation-method chooser and identify the updater on the Host.
  - Install previews a Host-selected default; Update starts the detected updater directly.
  - Verify package metadata and exported binary paths for npm launchers that resolve into separate native packages.
  - Add the official Claude npm updater; retain custom prefixes, Homebrew Node prefixes, Windows npm layouts, and Homebrew stable/latest casks.
  - Preserve application/Homebrew ownership and reject a client-selected updater that differs from the detected method.
  - Unknown ownership, migrations, and unsupported automatic updates show guidance without requiring users to choose an installation method.
- [x] 20. Complete source-based CLI regressions and required static checks; record results.

### Automatic ownership verification (2026-10-16)

| Check | Result |
| --- | --- |
| Duplicate sibling-key regression before the fix | Failed as expected: 3 unique keys for 4 siblings |
| Same regression after the fix | Passed across repeated opening, refresh, hidden progress, and closing |
| Focused management, management UI, and settings source tests | 44 passed, zero failures |
| Source-based CLI and integration regressions, broad command above | 743 tests: 733 passed, 10 platform/live tests skipped, zero failures |
| `pnpm run typecheck` | Passed after the final code change |
| `pnpm run version:check` | Passed; version remains 0.2.1-beta.12 |
| `pnpm run capability:check` | Passed |
| `pnpm run i18n:check` | Passed; zero blocking violations, 200 existing warnings |
| `git diff --check` | Passed |

New tests exercise distinct React sibling keys, the absence of method selectors, Host-selected installation defaults, npm package metadata with native-binary symlinks, unrelated metadata rejection, Homebrew cask channels and Node prefixes, Windows npm path selection, and rejection of an updater that does not match the detected owner. Filesystem fixtures and fake runners verify the selected command without executing an installer. The official Claude setup guide was rechecked for npm and cask behavior.

No build, live browser rendering, actual Agent upgrade, server operation, or Desktop operation was performed. Windows path selection is covered by fixtures; Windows execution and unsupported package-manager migrations were not exercised. Existing terminal progress, completion refresh, delegation placement, and unrelated workspace changes remain intact. Both Client and Host source changed; the running application must load the updated code through the user's Stage0 workflow.

## Follow-up: updater correctness and remaining manual checks

- [x] 21. Investigate the actual Claude, Pi, CodeBuddy, and ZCode installations without executing an updater.
  - Confirm Claude's npm launcher and prefer its documented `update` command; retain Homebrew ownership.
  - Remove the incorrect Pi 0.x migration guard. Preserve the actual npm package, including legacy package identity.
  - Inspect CodeBuddy's version-query fallback and align recognized npm upgrades with the official registry and detected prefix.
  - Reject exit-zero updates whose detected version does not advance.
- [x] 22. Integrate ZCode app checks and clarify unsupported/error states.
  - Verify the publisher's stable app manifest for four platform/architecture combinations.
  - Compare only identified bundled app runtime versions; show that installation finishes in the owning app.
  - Resolve Pi/CodeBuddy/Claude installation identity inside the background queue and retain known native/cask feeds.
  - Expose app-managed, missing-version, legacy-distribution, no-feed, and incomparable-channel reasons. Invalid version metadata is an error.
  - Record all 18 Agents and remaining integration gaps in `docs/调查报告/20261016-外部Agent更新通道与手动检查边界.md`.
- [x] 23. Verify management, update checks, UI feedback, and broad CLI regressions.

### Updater correctness verification (2026-10-16)

| Check | Result |
| --- | --- |
| Focused source regressions before final UI labels | 57 passed, zero failures |
| Final source-based CLI and integration regressions, broad command above | 749 tests: 739 passed, 10 platform/live tests skipped, zero failures |
| `pnpm run typecheck` | Passed after final source changes |
| `pnpm run version:check` | Passed; version remains 0.2.1-beta.12 |
| `pnpm run capability:check` | Passed |
| `pnpm run i18n:check` | Passed; zero blocking violations, 200 existing warnings |
| `git diff --check` | Passed |
| Read-only actual-installation plan selection | Claude → built-in update; Pi → existing npm package/prefix; CodeBuddy → official-registry npm/prefix |
| Live read-only checker | Claude 2.1.296 → 2.1.301; Pi 0.85.1 → 1.3.0; CodeBuddy 2.161.1 → 2.168.0; ZCode 3.14.4 → 3.15.3 |
| ZCode stable manifests | HTTP 200, version 3.15.3 for macOS arm64/x64, Windows x64, and Linux x64 |

Regression coverage includes package-preserving Pi upgrades, direct Claude updates, official-registry CodeBuddy commands, unchanged-version failures, app manifest parsing, reason labels and guidance, malformed release errors, delayed installation resolution, and npm/native/cask source selection. Read-only inspection did not run any Agent updater. No build, live browser rendering, server restart, DSH Desktop operation, commit, or publication was performed. Both Client and Host changes require the user's normal Stage0 code-loading workflow.

## Follow-up: remaining installation detection gaps

- [x] 24. Audit remaining ownership failures after the user's successful online-upgrade tests.
  - Confirm the actual standalone Codex path and current npm package identities without running an updater.
  - Recheck native Kimi/MiniMax update semantics; document interactive, migration, and installer-owned constraints separately from app-managed checks.
- [x] 25. Support recognized standalone Codex updates and align release channels.
  - Use the official unattended installer, retaining the detected install directory through positional arguments.
  - Preserve package-manager and application ownership and reject unidentified paths.
  - Use the standalone Codex channel and Homebrew Codex/Gemini feeds inside the asynchronous queue.
- [x] 26. Verify ownership selection, asynchronous checks, broad CLI regressions, and static checks.

### Remaining detection verification (2026-10-16)

| Check | Result |
| --- | --- |
| Initial focused management/check regressions | 30 passed, zero failures |
| Broad source-based CLI and integration suite before final active-launcher refinement | 751 tests: 741 passed, 10 platform/live tests skipped, zero failures |
| Final management, release-check, terminal UI, and settings regressions | 62 passed, zero failures or skips |
| `pnpm run typecheck` | Passed after the active-launcher refinement |
| `pnpm run version:check` | Passed; version remains 0.2.1-beta.12 |
| `pnpm run capability:check` | Passed |
| `git diff --check` | Passed |
| Read-only actual installation plans | Claude → native; Pi → npm with existing package/prefix; CodeBuddy → official-registry npm; Codex → unattended standalone installer |
| Live publisher metadata | Codex standalone 0.163.0; Homebrew Codex 0.163.0; Homebrew Gemini 0.46.0 |

The final focused command was:

```bash
node --import ./tests/register-source-loader.mjs --test --test-concurrency=1 tests/cli-management.spec.ts tests/cli-update-check.spec.ts tests/cli-management-ui.spec.ts tests/cli-settings-peer-host.spec.ts
```

New coverage verifies official standalone locations, preserved directory arguments, active versus inactive versioned releases, symlink ownership, fake update completion, separate npm/Homebrew/standalone feeds, invalid release tags, and nonblocking resolution. POSIX standalone tests are skipped on Windows, where this installer is not enabled. No Client text changed, so the existing i18n result remains applicable. No live upgrade, build, server operation, Desktop operation, commit, or publication was performed. The Host must load the changed source through the user's normal Stage0 workflow.
