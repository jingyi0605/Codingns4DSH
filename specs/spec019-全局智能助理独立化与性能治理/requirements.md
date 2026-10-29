# Requirements - Global Assistant Extraction and Performance Governance

Status: Draft

## Introduction

Users report that installing CodingNS4DSH can make the whole computer feel sluggish. The repository includes a broad global assistant spanning voice, conversation, workspace indexing, notifications, avatars, and a native companion window. Some work is opt-in or demand-driven, but assistant-related code and host services are also present in the base plugin, and there are recurring observers/timers whose cost needs to be measured rather than assumed harmless.

The goal is to make the assistant an independently installable DSH plugin and remove its product-specific runtime and UI from the base plugin, while separately identifying and eliminating avoidable continuous work. The extraction must retain a clear compatibility and data-migration path and must not claim performance improvement based only on code movement.

## Glossary

- **Base plugin**: CodingNS4DSH after assistant-specific features are removed.
- **Assistant plugin**: The separately installable DSH plugin that owns global assistant experiences.
- **Idle**: Neither assistant nor base-plugin user-visible work is in progress; no voice call, index build, active animation, settings interaction, or pending user request exists.
- **Continuous work**: Repeating timer, polling, observer callback, render loop, or recurring RPC/task that runs without a new user action or relevant source event.
- **Assistant data**: Assistant profile, prompts, voice/avatar configuration, managed workspace scope, conversation history, index/cache/journal, notifications, and assistant-owned assets.

## Scope

### In Scope

- Inventorying and separating assistant-specific Client, Host, shared, capability-adapter, RPC, configuration, asset, and test ownership.
- Delivering the assistant as an independent DSH plugin/package that can be installed, upgraded, disabled, and removed independently from the base plugin.
- Removing assistant-only code, startup work, UI registration, dependencies, assets, and settings from the base plugin after migration is verified.
- Measuring and reducing idle and active performance costs in both the base and assistant plugins.
- Preserving assistant data and existing workflows through explicit migration, downgrade, and failure behavior.

### Out of Scope

- Reworking unrelated CodingNS features or changing DSH core.
- Automatically installing, removing, enabling, disabling, or upgrading either plugin in a user Desktop profile.
- Claiming a specific user-machine cause before profiling reproduces it.
- Changing assistant product behavior except where required for independent ownership or to eliminate measured performance waste.

## Requirements

### Requirement 1: Independent plugin ownership

**User story:** As a CodingNS user, I want the global assistant distributed separately, so I can use the base plugin without carrying assistant runtime and resource costs.

#### Acceptance criteria

1. WHEN the base plugin is installed without the assistant plugin THEN the base plugin SHALL start, expose its supported features, and operate without importing or starting assistant-specific modules.
2. WHEN the assistant plugin is installed THEN it SHALL declare its own DSH manifest, lifecycle, feature registration, settings/UI ownership, dependency set, and version independently of the base plugin.
3. WHEN the assistant plugin is absent, disabled, incompatible, or fails to start THEN the base plugin SHALL remain operational and SHALL NOT repeatedly retry assistant startup or emit an unbounded error loop.
4. WHEN either package is built and tested THEN its production dependency graph SHALL NOT pull in the other package's implementation source as an implicit runtime dependency.

### Requirement 2: Complete extraction and removal

**User story:** As a maintainer, I want a precise ownership boundary, so assistant code is not left active or bundled in the base plugin after extraction.

#### Acceptance criteria

1. WHEN extraction is complete THEN assistant UI, Host services, assistant RPC routes, voice runtime, indexing/background work, notification pipeline, avatar integration, native companion, assistant-specific configuration, and assistant-only assets SHALL have an explicit owner in the assistant plugin or a documented shared contract.
2. WHEN the base plugin is packaged THEN its manifest, entry points, feature registries, exports, generated bundles, and dependency metadata SHALL contain no assistant-only implementation or resource files.
3. WHEN a module remains in the base plugin because it is a reusable DSH/CodingNS primitive THEN the Spec SHALL identify its non-assistant consumers and test that the assistant plugin consumes it through a stable contract rather than private source imports.
4. WHEN the assistant plugin is removed THEN base-plugin startup and unrelated settings/data SHALL remain valid; assistant-owned data SHALL be preserved unless the user explicitly requests deletion.

### Requirement 3: Safe settings and data migration

**User story:** As an existing assistant user, I want my profile and history preserved when ownership moves, so extraction does not reset configuration or lose records.

#### Acceptance criteria

1. WHEN the assistant plugin first starts against existing data THEN migration SHALL be versioned, idempotent, bounded, and performed only after explicit plugin activation.
2. WHEN migration fails or is interrupted THEN the source data SHALL remain recoverable and the assistant SHALL report a clear diagnostic without repeatedly retrying expensive work.
3. WHEN users downgrade or temporarily remove the assistant plugin THEN the base plugin SHALL not overwrite, delete, or reinterpret assistant-owned data.
4. WHEN settings ownership changes THEN existing keys SHALL either migrate to an assistant-owned namespace or remain backward-readable under a documented deprecation window.

### Requirement 4: Eliminate unnecessary idle work

**User story:** As a user, I want installation and idle operation to have negligible ongoing cost, so the rest of my computer remains responsive.

#### Acceptance criteria

1. WHEN neither plugin has active user-visible work THEN the base plugin SHALL run no assistant-owned timer, observer, animation loop, polling request, index task, voice worker, or companion refresh.
2. WHEN a feature requires recurring work THEN it SHALL start only while its owning feature is enabled and its qualifying state is active, and SHALL stop promptly when hidden, disabled, detached, or disposed where behavior permits.
3. WHEN a source event or explicit action can replace polling THEN the implementation SHALL use that event/action path; recurring polling SHALL have a documented reason, interval, overlap guard, and measured cost.
4. WHEN UI mounting uses DOM observation THEN it SHALL observe the smallest viable root, avoid rescanning unrelated DOM mutations, and disconnect once mounting is complete or the owning surface is removed.

### Requirement 5: Measurable performance acceptance

**User story:** As a maintainer, I want repeatable measurements and budgets, so performance improvements are demonstrable and regressions detectable.

#### Acceptance criteria

1. WHEN baseline and post-change profiles are captured THEN they SHALL use the same documented environment, workload, duration, and sampling method, and distinguish base-only, assistant-enabled-idle, and assistant-active states.
2. WHEN the base plugin is installed without the assistant plugin THEN its idle CPU, memory, timer/observer activity, and recurring RPC/network activity SHALL meet budgets recorded in the approved design before implementation.
3. WHEN the assistant is enabled but idle THEN recurring work SHALL be zero unless a documented product requirement justifies it; justified work SHALL have an explicit budget and test.
4. WHEN voice, indexing, avatar rendering, notifications, or companion functionality is active THEN each workload SHALL have a bounded resource budget, cancellation behavior, and a regression test or repeatable profiling procedure.
5. WHEN performance claims are reported THEN source inspection SHALL be labeled as a hypothesis, and measured results SHALL include raw evidence and limitations.

### Requirement 6: Preserve assistant behavior and compatibility

**User story:** As an existing user, I want the extracted assistant to keep its accepted workflows and host compatibility, so modularization does not regress voice, indexing, avatars, or notifications.

#### Acceptance criteria

1. WHEN assistant capabilities move THEN accepted contracts and behavior tracked by Specs 013, 013.1, 014, and 014.1 SHALL remain traceable to migration tasks and regression coverage.
2. WHEN the assistant plugin runs on a supported DSH version THEN capability probing and fallback behavior SHALL remain within the existing supported-version policy; the base plugin SHALL not acquire new assistant-specific DSH version branches.
3. WHEN user workflows require both plugins THEN compatibility SHALL be verified using isolated test fixtures and documented packaging, without operating a user's Desktop installation.
4. WHEN the new ownership boundary changes RPC, events, or shared types THEN compatibility SHALL be versioned, validated, and tested for missing, stale, duplicate, and incompatible plugin combinations.

## Non-functional Requirements

### Performance

- No assistant-only recurring work may be active in the base-only idle state.
- Approved numeric budgets must be established from a reproducible baseline before implementation tasks that change runtime behavior begin.
- Work triggered by user actions or real source events must be bounded, cancellable, and non-overlapping unless concurrency is explicitly required.

### Reliability

- Feature teardown must release timers, observers, subscriptions, workers, RPC registrations, child processes, and temporary resources.
- Failure or removal of the assistant plugin must not disable unrelated base-plugin features.

### Maintainability

- The extraction boundary must be enforced by package/build checks and tests, not by comments alone.
- Shared contracts must be small, stable, and owned by a neutral layer; no cross-plugin deep imports.

## Success Definition

- Base-only package and runtime contain no assistant-specific implementation and pass base-plugin regression tests.
- Independent install/disable/remove lifecycle and migration behavior pass isolated tests without touching Desktop.
- Idle profiles show no unexplained assistant-owned recurring work; numeric CPU/memory/network/timer budgets are met.
- Existing assistant workflows retain traceable acceptance evidence in the new plugin's tests and migration records.
