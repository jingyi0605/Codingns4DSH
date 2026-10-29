# Design - Global Assistant Extraction and Performance Governance

Status: Approved for implementation; standalone source assembly is implemented and locally verified. Extraction remains blocked on data migration/rollback, full workflow and live DSH runtime verification, clean dependency installation, and matched runtime profiling.

## 1. Overview

### 1.1 Goals

- Move the global assistant into an independently installable DSH plugin and remove its implementation and resources from the base CodingNS4DSH package.
- Reduce continuous background activity based on profiling, not intuition.
- Preserve data, accepted workflows, capability boundaries, and unrelated base-plugin behavior.

### 1.2 Requirements Covered

- `requirements.md` Requirements 1-6.

### 1.3 Constraints

- No DSH core changes are assumed.
- Both plugins must use public/stable plugin boundaries and capability probing; neither may deep-import the other's private implementation.
- Desktop profile/process/install operations are prohibited unless separately authorized for a specific action, target, and timing.
- The independent project target is `/Users/jackson/Code/CodingNS/data/dsh-global-assistant`.
- Do not guess machine-specific CPU or memory limits. The enforceable initial budget is zero assistant-owned recurring runtime work in the base-only package; active/idle numeric measurements must be recorded on an isolated non-Desktop test runtime before performance claims are made.

## 2. Architecture

### 2.1 Ownership split

The base plugin owns general workspace/session aggregation, networking, developer tooling, and reusable platform services. The assistant plugin owns the global assistant product end to end: assistant configuration and lifecycle, conversation and voice, indexing and automation, notifications, avatar management/rendering, assistant-specific Client UI, Host RPC/services, desktop companion, assistant assets, and assistant-specific tests/locales.

The source inventory in `docs/20261029-助理模块现状与性能热点.md` identifies likely ownership by current locations. It is an initial map, not a complete deletion list. Every retained shared module must name a non-assistant consumer.

### 2.2 Plugin relationship

The assistant plugin is intended to be independently packaged and registered by DSH. The current implementation directly depends on base-owned CodingNS settings/RPC, Host workspace/session and PeerHost gateway, shared config and feature types, and capability adapters. An independent DSH contract for those services was not verified in the source-only audit. Do not move implementation until that boundary is designed and tested; copying donor files into the destination does not count as extraction.

The user selected a separate project directory at `/Users/jackson/Code/CodingNS/data/dsh-global-assistant`. Its installable artifact, version, manifest, dependency graph, and test suite must be independent. The directory is not to be initialized as a Git repository or published without separate authorization.

### 2.3 Candidate current ownership map

| Area | Current locations (initial inventory) | Target owner |
| --- | --- | --- |
| Client entry, panel, assistant UI | `src/client/features/global-voice-assistant.ts`, `src/client/features/assistant-*`, assistant locale modules | Assistant plugin |
| Host services and RPC | `src/host/features/global-voice-rpc.ts`, `src/host/features/assistant-*` | Assistant plugin |
| Voice runtime and lease | `src/host/features/global-voice-coordinator.ts`, voice stream/runtime files, `src/client/sherpa-voice-adapter.ts` | Assistant plugin |
| Notifications | `src/host/features/assistant-notification-*`, client notification store, shared notification contracts | Assistant plugin, except any proven generic event primitive |
| Avatar and desktop companion | `src/client/avatar/`, `src/host/avatar/`, `src/host/desktop-assistant/`, `assets/desktop-assistant/`, assistant avatar assets | Assistant plugin |
| Assistant contracts and persistence | assistant-specific files in `src/shared/`, config contracts, assistant storage/cache/index code | Assistant plugin, with versioned migration |
| Neutral platform adapters | `src/dsh-capabilities/` assistant-specific adapters and any generic capability used elsewhere | Split by consumer; no private cross-package imports |

This table is not permission to delete files: implementation must follow actual import/build graphs, consumers, persistence ownership, manifests, and test coverage.

## 3. Performance Model

### 3.1 State separation

Measurements distinguish:

1. **Base-only idle**: base plugin enabled; assistant plugin absent; no interactive action.
2. **Assistant enabled idle**: assistant plugin enabled, profile/settings loaded, but no active call, index build, animation, or user interaction.
3. **Assistant active workloads**: voice call, indexing, conversation, notification stream, avatar, and native companion measured independently and in representative combinations.

### 3.2 Cost inventory and profiling

Task 0 has enumerated source-level timers, observers, animation frames, polling, subscriptions, workers and child processes, and identified persistence/config/RPC owners. Runtime CPU, memory, event-loop/long-task behavior, recurring network/RPC, and callback profiles remain outstanding and require an isolated non-Desktop test runtime.

The enforceable base-only budget is zero assistant-owned feature startups and zero assistant-owned recurring work. Machine-specific CPU/memory budgets must be measured on a documented isolated environment before performance claims are made. A source-level timer count is not a performance result. Keep raw profile artifacts outside tracked user data unless explicitly requested; summarize reproducible steps and metrics in the Spec.

### 3.3 Known hypotheses to verify

- The client assistant launcher still observes the whole body subtree until the session button appears, but now inspects only added subtrees and disconnects after mounting; measure realistic DOM churn and effect recreation.
- The native companion Client still polls its active state while attached; the Host notification path has been converted from 250 ms polling to revision events.
- Host assistant RPC, avatar, and companion features now share the `globalVoiceAssistant` enablement key; they default off, and avatar/companion features depend on the assistant Host module. Verify the disabled-by-default feature registry behavior and measure remaining base-only startup cost.
- Spritesheet rendering uses `requestAnimationFrame` while visible and stops when hidden or reduced motion is requested. It is demand/visibility gated and should not be treated as an idle leak without evidence.
- Voice model/runtime, speech worker, LLM calls, and index tasks are mostly demand-triggered; test whether resources return to baseline after stop/cancel and plugin teardown.

These are source observations and hypotheses, not proof that any one component caused user reports.

### 3.4 Design rules for recurring work

- Prefer source events to polling and user action to eager background refresh.
- Avoid whole-document observation; target the smallest stable mount point, make mounting idempotent, and stop observing after success when possible.
- Gate timers by active state, avoid overlapping async polls, use backoff only for recoverable active work, and dispose deterministically.
- Avoid importing heavyweight assistant modules in the base plugin or eagerly loading them in the assistant plugin before activation.
- Preserve visible behavior while removing work; every optimization needs a targeted lifecycle test.

## 4. Migration and Compatibility

### 4.1 Migration sequence

1. Capture baseline and complete import, config, RPC, data, and package inventory.
2. Define the standalone package boundary and neutral contracts; add package-level tests before moving runtime. (Implemented in the sibling project; clean-install and live Gateway/Client verification remain open.)
3. Build the independent assistant package and run it in isolated fixtures while the old implementation remains the source of truth.
4. Add an explicit, versioned, idempotent migration with backup/rollback semantics and no automatic work until assistant activation.
5. Switch ownership and remove assistant registrations, RPC, imports, assets, and dependencies from the base package.
6. Verify base-only operation, assistant lifecycle, upgrade/downgrade, missing-plugin behavior, and performance in isolated environments.

### 4.2 Data ownership

Assistant profile, prompts, conversation history, indexes, journals, notification state, avatar configuration/assets, and voice model configuration must have an explicit storage owner. Migration must not move or delete data until destination validation succeeds. Large voice/model/avatar files should be referenced or copied using bounded, cancellable operations, avoiding duplicate full copies where a safe stable path can be retained.

### 4.3 Compatibility boundary

Use DSH capability probing for DSH-specific surfaces. Shared contracts must be neutral, versioned, and small. The base plugin must not retain assistant-specific RPC allowlists, config validators, UI slots, or capability routes solely to keep the extracted plugin working. An optional bridge is permitted only if it remains useful and tested when either side is absent.

## 5. Correctness Properties

### 5.1 Base isolation

For any base-only installation, enabling unrelated features SHALL NOT import or start assistant-owned modules, and assistant absence SHALL NOT change base feature lifecycle.

**Validation:** Requirements 1-2; package graph and isolated registry tests.

### 5.2 Teardown completeness

For any feature lifecycle, after stop/dispose there SHALL be no owned timer, observer, animation loop, worker, event listener, RPC route, child process, or pending recurring request, except explicitly documented OS cleanup grace periods.

**Validation:** Requirements 4-5; fake-clock/lifecycle tests and resource instrumentation.

### 5.3 Migration safety

For any migration failure point, original assistant data SHALL remain readable and a retry SHALL not duplicate or corrupt already migrated records.

**Validation:** Requirements 3 and 6; failure-injection and idempotence tests.

## 6. Test Strategy

### 6.1 Unit and lifecycle tests

- Timer/observer gating, DOM mutation scan counts, cancellation, overlap prevention, teardown, and restart.
- Settings migration idempotence, backup/rollback, namespace ownership, and legacy compatibility.
- Capability/RPC behavior with base only, assistant only, both, absent peer, duplicate peer, incompatible version, and failure during startup.

### 6.2 Package and integration tests

- Independently build/typecheck/test the base package and assistant package.
- Assert package artifact contents and dependency graphs exclude the other package's implementation.
- Exercise existing accepted assistant flows and base-plugin representative workflows in isolated fixtures.

### 6.3 Performance tests

- Matched 5-minute idle profiles for base-only and assistant-enabled-idle (duration can be adjusted in approved protocol, but must be long enough to observe all recurring intervals).
- Active profiles for voice, index build, avatar rendering, notifications, and native companion.
- Repeated start/stop and install/disable/remove lifecycle with resource counts before/after.
- Numeric pass/fail budgets are added to this section after baseline and user review; no budget is implied by this draft.

### 6.4 Requirement mapping

| Requirement | Design sections | Verification |
| --- | --- | --- |
| 1-2 | §§2.1-2.3, 4.3 | Package graph, bundle-content and feature-registry tests |
| 3 | §4.2, §5.3 | Migration idempotence and failure-injection tests |
| 4-5 | §§3, 5.2, 6.3 | Lifecycle tests and matched profiling protocol |
| 6 | §§4.1, 4.3, 6.2 | Existing assistant regression matrix and version fixtures |

## 7. Risks and Open Decisions

### 7.1 Risks

- The feature spans shared settings, RPC allowlists, session/query data, avatar assets, and native companion processes; naive file movement can leave orphaned registrations or break existing data.
- The reported whole-computer lag may be caused by DSH, another plugin, a specific avatar renderer, or workload interactions. A matched baseline is essential before attributing causality.
- Separate plugin packaging may expose missing stable DSH APIs or require a neutral contract package.
- Existing assistant Specs contain partially completed real-device acceptance; extraction must preserve those open gaps instead of treating source tests as complete product validation.

### 7.2 Decisions required before source implementation

- Choose separate repository versus independently packaged monorepo workspace based on DSH packaging and release constraints.
- Review and approve numeric performance budgets and the reference profiling environment.
- Decide whether assistant-owned data remains in its current DSH home subtree or migrates to a package-specific subtree, including rollback policy.
- Identify every shared primitive with a non-assistant consumer before removing assistant source.
