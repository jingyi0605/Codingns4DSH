# Task List - Magpie Session Context Component

Status: Complete

## Purpose

This task list records the implementation order and the verification evidence for Spec 18.2.

## Status values

- `TODO`: not started
- `IN_PROGRESS`: currently being implemented
- `BLOCKED`: blocked by an external condition
- `IN_REVIEW`: implementation exists and awaits verification
- `DONE`: completed and verified
- `CANCELLED`: explicitly not implemented, with reason

## Phase 0: Establish the Spec

- [x] 0.1 Record requirements and design
  - Status: DONE
  - What this does: Create the Spec 18.2 requirements, design, and task documents from the repository template.
  - What becomes visible: The Magpie context panel scope, native fallback, data contract, and verification plan are explicit.
  - Dependencies: None.
  - Read first: `specs/000-Spec规范/Spec模板/README.md`; repository `AGENTS.md`.
  - Main files:
    - `specs/spec018.2-Magpie会话上下文组件/requirements.md`
    - `specs/spec018.2-Magpie会话上下文组件/design.md`
    - `specs/spec018.2-Magpie会话上下文组件/tasks.md`
  - Explicit non-goals: No code or runtime changes in this task.
  - Done when: Each task has a clear input, output, dependency, scope boundary, and verification path.
  - Verify: Manual Spec consistency review.
  - Requirements/design: All requirements; design §§1-8.

## Phase 1: Add the Host data path

- [x] 1.1 Add the bounded Magpie context contract and parser
  - Status: DONE
  - What this does: Define the stable context snapshot shape and reduce Magpie's response to bounded category/item/point metadata.
  - What becomes visible: Tests can consume a sanitized six-category snapshot without importing Magpie response types.
  - Dependencies: 0.1.
  - Read first: `requirements.md` Requirements 2-3; `design.md` §§3.2-3.3, 6.3; existing `MagpieUsageService` parser.
  - Main files:
    - `src/shared/contracts/magpie-management.ts`
    - `src/host/cli-adapters/magpie-usage.ts`
    - `tests/magpie-usage.spec.ts`
  - Explicit non-goals: No raw prompt text, provider writes, or Client UI.
  - Done when: Valid, malformed, oversized, mismatched, and text-bearing responses have deterministic parser outcomes.
  - Verify: Focused Magpie parser tests.
  - Requirements/design: Requirements 2-3; design §§3.2, 5, 6.3, 7.1.

- [x] 1.2 Expose session-gated context RPC
  - Status: DONE
  - What this does: Resolve whether a DSH session uses a Magpie model, read the exact Magpie session, and expose it through `magpie/context`.
  - What becomes visible: Client callers receive a snapshot only for the selected Magpie-backed session; all other sessions receive `null`.
  - Dependencies: 1.1.
  - Read first: `requirements.md` Requirements 1-2; `design.md` §§2.1, 2.3, 3.3, 5; existing Magpie Web lifecycle.
  - Main files:
    - `src/host/cli-adapters/feature.ts`
    - `src/host/rpc.ts`
    - `tests/cli-adapters.spec.ts`
    - `tests/magpie-usage.spec.ts`
  - Explicit non-goals: No automatic session binding based on Agent-only or fuzzy matches; no Desktop or server operation.
  - Done when: Provider/model gating, exact identity matching, Web API errors, and RPC allowlisting are covered.
  - Verify: Focused Host RPC and Magpie Web mock tests.
  - Requirements/design: Requirements 1-2; design §§2.1-2.3, 3.3, 5.

### Phase check

- [x] 1.3 Verify the Host boundary
  - Status: DONE
  - What this does: Check that the new contract and RPC are bounded, session-isolated, and compatible with the existing usage RPC.
  - What becomes visible: The Client can rely on one stable response shape and native fallback semantics.
  - Dependencies: 1.1, 1.2.
  - Read first: `requirements.md`; `design.md`; `tasks.md`.
  - Main files: All Phase 1 files.
  - Explicit non-goals: No custom UI or visual styling.
  - Done when: Parser, exact matching, and RPC tests pass and no raw prompt text crosses the boundary.
  - Verify: Focused tests and `git diff --check`.
  - Requirements/design: Requirements 1-2; design §§3-6.

## Phase 2: Build the session context component

- [x] 2.1 Add the Client context store and screenshot-shaped panel
  - Status: DONE
  - What this does: Coalesce per-session reads and render the trigger, anchored panel, six categories, cache summary, request points, and bounded content list.
  - What becomes visible: A Magpie-backed session's context component matches the supplied information hierarchy and remains usable on narrow screens.
  - Dependencies: 1.3.
  - Read first: `requirements.md` Requirement 3; `design.md` §§2.3.2, 3.1, 4.2, 7; screenshot supplied by the user.
  - Main files:
    - `src/client/magpie-context-meter.ts`
    - `src/client/magpie-context-store.ts`
    - `src/client/locales/magpie.ts`
    - `tests/magpie-context.spec.ts`
    - `tests/session-performance.spec.ts`
  - Explicit non-goals: No native DSH component changes for non-Magpie sessions; no raw text viewer.
  - Done when: Trigger, panel, category tabs, aggregate sections, content rows, loading/error, and narrow layout are covered.
  - Verify: Static markup/DOM tests and focused Client tests.
  - Requirements/design: Requirement 3; design §§3.1, 4.2, 7.1, 7.3.

- [x] 2.2 Integrate the meter into the native composer presentation
  - Status: DONE
  - What this does: Register a zero-layout dock enhancer, project Magpie pressure into the native context meter, and redirect only the native trigger while a valid snapshot is ready.
  - What becomes visible: Magpie sessions keep one native-looking button and open the new panel; other sessions retain the native meter and existing activity behavior.
  - Dependencies: 2.1.
  - Read first: `src/dsh-capabilities/client/session-performance-adapter.ts`; `src/dsh-capabilities/client/composer-presentation-adapter.ts`; `design.md` §§2.1, 2.3.1.
  - Main files:
    - `src/dsh-capabilities/client/session-performance-adapter.ts`
    - `src/client/features/cli-adapters.ts`
    - `tests/session-performance.spec.ts`
  - Explicit non-goals: No change to native projection definitions or the activity/performance display.
  - Done when: Slot registration, late native registration, session switching, native fallback, and disposal are verified.
  - Verify: Focused session presentation tests.
  - Requirements/design: Requirements 1 and 4; design §§2.3, 4.2, 6.1-6.2.

### Phase check

- [x] 2.3 Verify visual and lifecycle integration
  - Status: DONE
  - What this does: Check the component's key visual states and that the custom panel cannot leak between sessions or after disposal.
  - What becomes visible: The full user-facing path is represented by automated fixtures without needing a running Desktop.
  - Dependencies: 2.1, 2.2.
  - Read first: `requirements.md`; `design.md`; `tasks.md`.
  - Main files: All Phase 2 files and tests.
  - Explicit non-goals: No live Desktop verification.
  - Done when: Magpie and native screenshots' structural states are covered and cleanup is deterministic.
  - Verify: Focused tests, typecheck, and `git diff --check`.
  - Requirements/design: Requirements 1, 3, 4; design §§3, 6, 7.

## Phase 3: Final verification and record

- [x] 3.1 Run repository checks and record the implementation
  - Status: DONE
  - What this does: Run the required checks and write a dated implementation record with actual results and remaining operational limits.
  - What becomes visible: A handoff-ready verification record for Spec 18.2.
  - Dependencies: 1.3, 2.3.
  - Read first: `requirements.md`; `design.md`; `tasks.md`; relevant Magpie feasibility report.
  - Main files:
    - `specs/spec018.2-Magpie会话上下文组件/docs/20261025-Magpie会话上下文组件实现记录.md`
    - Spec 18.2 documents
  - Explicit non-goals: No build, development server, Stage0, Desktop, commit, release, or publication.
  - Done when: All required commands have actual results, tasks are marked accurately, and unperformed live checks are explicit.
  - Verify: `pnpm run typecheck`; `pnpm run version:check`; `pnpm run capability:check`; `pnpm test`; `git diff --check`.
  - Requirements/design: All requirements; design §7-8.

- [x] 3.2 Final Spec review
  - Status: DONE
  - What this does: Confirm every acceptance criterion maps to code and tests and no unrelated worktree changes were overwritten.
  - What becomes visible: Spec 18.2 is ready for handoff or review.
  - Dependencies: 3.1.
  - Read first: All Spec 18.2 files and the implementation record.
  - Main files: Spec 18.2 documents and changed source/tests.
  - Explicit non-goals: No additional feature scope.
  - Done when: Requirements, design, tasks, verification evidence, risks, and fallback behavior agree.
  - Verify: Manual traceability review and final `git status --short`/`git diff --check`.
  - Requirements/design: All requirements; full design.

- [x] 3.3 Correct the native popup binding across DSH slot wrappers
  - Status: DONE
  - What this does: Find the native context trigger through the enclosing composer dock instead of the slot entry's immediate parent.
  - What becomes visible: Clicking the existing native context button opens the Magpie panel once valid data is ready.
  - Main files: `src/client/magpie-context-meter.ts`; `tests/magpie-context-dom.spec.ts`.
  - Verify: 89 focused source tests passed; typecheck, version check, capability check, and diff check passed. The DOM fixture reproduced the original failure before the source correction.
  - Explicit non-goals: No build, development server, Desktop operation, or live visual replay.
