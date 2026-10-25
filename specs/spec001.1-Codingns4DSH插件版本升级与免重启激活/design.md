# Design - Codingns4DSH Plugin Updates and No-Desktop-Restart Activation

Status: Implemented with release-pinned manager delegation and explicit unsupported Desktop activation.

## 1. Overview

### 1.1 Goals

- Give the settings page a reliable update-check and release-note surface.
- Keep package installation under DSH's profile and Desktop ownership boundaries.
- Make Host activation and Client reload observable as independent facts.
- Support no-Desktop-restart activation only when the DSH runtime explicitly confirms it.
- Preserve safe fallback for existing DSH versions, unsupported Desktop builds, and failed updates.

### 1.2 Covered requirements

- `requirements.md` Requirements 1-9

### 1.3 Technical constraints

- Client: React settings UI using the existing settings section and Client-to-Host RPC bridge.
- Host: TypeScript Host RPC and adapter services inside Codingns4DSH.
- Version metadata: npm registry metadata and exact GitHub tag/release metadata.
- Package mutation: official DSH Plugin Manager or Desktop-owned bridge only.
- Activation: DSH capability routes; no private loader or ESM cache manipulation.
- Compatibility: current DSH capability matrix and the target package's declared DSH constraints.
- Security: owner-scoped Host operation, bounded responses, no credentials or profile paths in Client data.

## 2. Architecture

### 2.1 System structure

```text
Codingns4DSH Settings Client
  -> update/check and update/apply RPC
Codingns4DSH Host
  ├── Update Metadata Service
  │    ├── npm registry adapter
  │    └── GitHub tag/release adapter
  ├── Compatibility Evaluator
  ├── DSH Update Capability Adapter
  │    ├── Plugin Manager adapter (Web/live profile)
  │    └── Desktop-owned bridge adapter (Desktop)
  └── Activation Status Adapter
       ├── Host lifecycle status
       └── Client reload/graph status
```

The Client never talks directly to npm, GitHub, the profile filesystem, or a package manager. The Host owns network access and authorization. The DSH manager owns package mutation. The settings UI renders the returned state without inferring activation.

### 2.2 Module responsibilities

| Module | Responsibility | Input | Output |
| --- | --- | --- | --- |
| `UpdateMetadataService` | Read npm package metadata and normalize channels | Package name, channel, registry policy | Version candidates and target metadata |
| `ReleaseNotesService` | Read the exact GitHub tag/release | Repository, exact version | Bounded release record or unavailable |
| `UpdateCompatibilityService` | Compare target manifest with running DSH | Target metadata, DSH version, capability profile | Compatible, incompatible, or unknown |
| `DshUpdateCapability` | Detect and call the supported package manager | Exact package and version | Install/update operation handle and outcome |
| `ActivationCapability` | Observe Host and Client activation | Target version, manager operation | Host/client activation facts |
| `UpdateRpc` | Authorize, validate, and expose the Host boundary | Client request | Stable CodingNS result envelope |
| `UpdatePanel` | Render channels, notes, confirmation, progress, and result | Stable update contract | Settings UI |

### 2.3 Capability boundary

The implementation SHALL add stable internal capability identifiers before consuming DSH-specific APIs. The first planned identifiers are:

- `plugin.update.inspect`: the current profile can expose installed and updatable bundle metadata.
- `plugin.update.apply`: the current profile can perform an owner-authorized exact bundle update.
- `plugin.host.activation-status`: the Host can report whether the target package is active.
- `plugin.client.reload-status`: the Client can report whether the target Client bundle is active.

The capability routes may resolve to different DSH implementations. The settings UI sees only the internal status and diagnostics, not DSH version branches.

## 3. Components and interfaces

### 3.1 Core components

- `UpdateMetadataService`: npm and GitHub read-only metadata.
- `UpdateCompatibilityService`: semver and manifest constraint evaluation.
- `DshUpdateCapability`: official package-manager invocation and progress.
- `ActivationStatusService`: separate Host and Client runtime status.
- `CodingNsUpdateRpcHandler`: owner checks and stable RPC actions.
- `CodingNsUpdatePanel`: settings UI and explicit update confirmation.
- `CodingNsSettingsUpdate`: the existing header's version disclosure, shared update-store lifetime, and available-version label.

#### 3.1.1 Header version entry

The existing brand/GitHub banner remains at the top of settings. Its version pill is a native button with `aria-expanded` and `aria-controls`. Clicking it expands update details across the banner's width. The updater has no separate settings card or switch; its internal Client capability registration has no UI descriptor.

The banner keeps a separate non-wrapping row for the original brand, message, and GitHub columns. Expanded details are a sibling beneath that row. Only the original mobile breakpoint stacks the columns. The original pill height is retained, and the added chevron is removed.

A compact `New` label occupies a permanently reserved slot beside the version pill; the full target version is available through its tooltip, accessible label, and expanded details. Inline-size containment keeps the version row from contributing to the brand's intrinsic width. Symmetric spacing preserves the original centered pill on mobile. Label presence and target-string length therefore do not move the other header elements or resize the banner.

`CodingNsSettingsUpdate` owns one `PluginUpdateStore` shared by the version label and details panel. It loads runtime/operation state and performs one bounded metadata check on the first visible render, using `next` for a prerelease build and `latest` otherwise. Visibility changes and expansion do not repeat that check; subsequent checks are explicit. Collapsing details preserves their selected channel, reviewed target, and operation state. Disposing settings cancels requests and polling.

The label compares the checked target against loaded Client, loaded Host, and known installed versions. It never advertises an equal or older target as an upgrade. A newer incompatible target still has a new-version label; its details explain why installation is blocked. A failed refresh preserves the last known label and release details. Confirmed installation refreshes the installed version and removes the label when that version reaches the target.

The presentation-only `CodingNsSettingsPromo` accepts version-control and detail nodes without reading settings or updater state. Existing DSH theme tokens, GitHub link behavior, and narrow-screen banner layout are preserved.

### 3.2 Data structures

#### 3.2.1 `UpdateChannel`

| Field | Type | Required | Description | Constraint |
| --- | --- | --- | --- | --- |
| `kind` | `'latest' \| 'next' \| 'exact'` | yes | Selected distribution channel | Fixed allowlist |
| `version` | `string` | no | Exact target for `exact` | Valid semver only |
| `registry` | `string` | no | Explicit registry when allowed | HTTPS URL in configured allowlist |

#### 3.2.2 `UpdateCheckResult`

| Field | Type | Required | Description | Constraint |
| --- | --- | --- | --- | --- |
| `packageName` | `string` | yes | Codingns4DSH package name | Fixed package identity |
| `runningHostVersion` | `string \| null` | yes | Loaded Host version | Bounded semver or null |
| `runningClientVersion` | `string \| null` | yes | Loaded Client version | Bounded semver or null |
| `installedVersion` | `string \| null` | yes | Profile/package-manager version | Bounded semver or null |
| `channel` | `UpdateChannel` | yes | Query selection | Validated |
| `target` | `UpdateTarget \| null` | yes | Selected target | Null when no newer target |
| `state` | `string` | yes | Check state | Fixed state union |
| `checkedAt` | `string` | yes | Check time | ISO timestamp |

`state` is one of `up-to-date`, `update-available`, `no-newer-version`, `incompatible`, `compatibility-unknown`, `unavailable`, or `unsupported`.

#### 3.2.3 `UpdateTarget`

| Field | Type | Required | Description | Constraint |
| --- | --- | --- | --- | --- |
| `version` | `string` | yes | Exact npm target | Valid semver |
| `publishedAt` | `string \| null` | yes | npm publication time | ISO timestamp or null |
| `distTags` | `string[]` | yes | Tags containing the target | Allowlisted tag names |
| `gitHead` | `string \| null` | yes | npm source commit | Bounded commit SHA or null |
| `compatibility` | `CompatibilityStatus` | yes | DSH compatibility result | Fixed status object |
| `release` | `ReleaseRecord` | yes | GitHub release state | Bounded record |

#### 3.2.4 `UpdateApplyResult`

| Field | Type | Required | Description | Constraint |
| --- | --- | --- | --- | --- |
| `operationId` | `string` | yes | Correlation ID | Host-generated opaque ID |
| `targetVersion` | `string` | yes | Requested target | Exact semver |
| `packageState` | `'unchanged' \| 'installed' \| 'rolled-back' \| 'unknown'` | yes | Package operation result | Fixed union |
| `hostActivation` | `ActivationState` | yes | Host state | Fixed state object |
| `clientReload` | `ActivationState` | yes | Client state | Fixed state object |
| `application` | `'applied-without-desktop-restart' \| 'restart-required' \| 'failed' \| 'cancelled' \| 'activation-unknown'` | yes | User-facing final result | Derived only from facts |
| `nextStep` | `string` | yes | Safe user instruction | Bounded text |

`ActivationState` contains `state` (`not-requested`, `pending`, `active`, `restart-required`, `unsupported`, `failed`, or `unknown`), an optional active version, and a bounded diagnostic code. It never contains filesystem paths or raw loader errors.

### 3.3 RPC contract

`update/runtime` reads the loaded Host version and manager-reported installed version without npm/GitHub access. All updater actions require a Connection owner. `apply` and `cancel` additionally require trusted local socket and browser-origin provenance from the transport; relayed and legacy Fetch mutations are rejected.

#### 3.3.1 `update/check`

- Type: Host RPC read.
- Input: `{ channel: UpdateChannel }`.
- Output: `UpdateCheckResult`.
- Authorization: owner-scoped read; public metadata may be cached, but the Host still owns the request.
- Validation: package identity and channel are fixed; registry is allowlisted.
- Errors: structured `UPDATE_METADATA_UNAVAILABLE`, `UPDATE_INVALID_CHANNEL`, or `UPDATE_UNSUPPORTED`.

#### 3.3.2 `update/apply`

- Type: Host RPC mutation.
- Input: `{ version: string, confirmation: true, checkedAt: string }`.
- Output: `UpdateApplyResult` or an operation handle followed by progress events.
- Authorization: current Codingns4DSH Host owner only; peer and remote Web contexts are rejected.
- Validation: the target must be the exact version returned by a recent compatible check, or the Host must repeat the check.
- Errors: compatibility, ownership, manager, cancellation, activation, and restart-required results use stable error/result codes.

#### 3.3.3 `update/status`

- Type: Host RPC read.
- Input: `{ operationId: string }`.
- Output: the latest bounded `UpdateApplyResult` or `operation-not-found`.
- Purpose: recover UI state after a Client reconnect or a lost progress response.

Completed operations are retained in a bounded Host-memory history of ten records. A Host replacement or restart can remove this history; missing operation status never establishes success or cancellation. `update/cancel` delegates cancellation to the official manager and keeps showing pending until the operation itself settles. No cancellation is inferred from a closed page.

Every operation status carries a monotonically increasing `revision`. The Client rejects older revisions for the same operation, and cancellation and polling responses can only change the operation they requested. Recovery is deferred while an apply response is pending. A successful recovery at the current revision clears a transient transport error and resumes polling.

### 3.4 External metadata contracts

#### npm

The adapter reads package metadata for the fixed package `@jingyi0605/codingns4dsh`, including `dist-tags`, exact version manifests, publication time, `engines.dsh`, peer dependencies, and `gitHead`. It SHALL not treat `latest` as the newest prerelease automatically.

#### GitHub

The adapter reads:

- `GET /repos/jingyi0605/Codingns4DSH/releases/tags/v<version>` for release notes.
- `GET /repos/jingyi0605/Codingns4DSH/git/ref/tags/v<version>` or an equivalent tag endpoint only when commit verification is needed.

The repository and tag prefix are fixed. A missing release SHALL not fall back to `main`, `master`, or another tag.

## 4. Data and state model

### 4.1 Data relationships

- One check key is `(packageName, channel, registry, runningDshVersion)`.
- One check result can point to one exact target version.
- One target version can have one npm manifest and zero or one exact GitHub release record.
- One apply operation is correlated by an opaque `operationId` and one exact target version.
- Package state, Host activation, and Client reload are independent fields; the final application state is derived from all three.

### 4.2 Update state flow

| State | Meaning | Entered by | Exit |
| --- | --- | --- | --- |
| `idle` | No query has run | Settings mount | `checking` |
| `checking` | npm/GitHub metadata is being read | User refresh | `ready`, `unavailable`, `unsupported` |
| `ready` | A stable check result is available | Metadata success | `confirming`, new check, dispose |
| `confirming` | User is reviewing exact target and notes | Update click | `applying`, cancel |
| `applying` | Official package operation is running | Explicit confirmation | `installed`, `failed`, `cancelled` |
| `installed` | Package state changed, activation not yet settled | Manager success | `activating`, `restart-required`, `activation-unknown` |
| `activating` | Host/Client activation evidence is being collected | Manager result | `applied-without-desktop-restart`, `restart-required`, `failed` |
| `restart-required` | Installation may be complete but live activation needs restart | Manager/capability result | User restarts and reopens settings |
| `failed` | Operation or activation failed | Any failure | Retry or native manager |

### 4.3 Final result derivation

The updater may return `applied-without-desktop-restart` only when:

1. `packageState === 'installed'`;
2. Host activation is `active` for the target version;
3. Client reload is `active` for the target version; and
4. no DSH capability reports a pending restart or stale graph.

Every other combination maps to a non-success state. Installation success alone maps to `restart-required` or `activation-unknown`, never to `applied-without-desktop-restart`.

## 5. Error handling

### 5.1 Error types

- `UPDATE_INVALID_CHANNEL`: malformed or unsupported channel input.
- `UPDATE_METADATA_UNAVAILABLE`: npm or GitHub could not be read.
- `UPDATE_RELEASE_NOT_FOUND`: exact tag or release is missing.
- `UPDATE_INCOMPATIBLE_DSH`: target manifest rejects the running DSH.
- `UPDATE_CAPABILITY_UNAVAILABLE`: official package or activation capability is missing.
- `UPDATE_FORBIDDEN`: caller is not the Host owner.
- `UPDATE_CONFLICT`: another operation is active or the check is stale.
- `UPDATE_MANAGER_FAILED`: official manager rejected or failed the package operation.
- `UPDATE_RESTART_REQUIRED`: package is installed but live activation requires restart.
- `UPDATE_ACTIVATION_UNKNOWN`: package state changed but one activation side cannot be confirmed.
- `UPDATE_STALE_RESPONSE`: response belongs to a superseded check or operation.

### 5.2 Error response format

The RPC uses the existing CodingNS error envelope. User-facing results contain only:

```json
{
  "code": "UPDATE_RESTART_REQUIRED",
  "message": "The update is installed but DSH must be restarted before it becomes active.",
  "operationId": "opaque-operation-id",
  "targetVersion": "0.2.1-rc.4",
  "nextStep": "Restart DSH from the native Desktop Plugins flow."
}
```

Raw npm output, GitHub response bodies outside the bounded release body, profile paths, credentials, and loader stack traces do not cross the Client boundary.

### 5.3 Handling strategy

1. Validate package, channel, target, and owner before network access or mutation.
2. Coalesce read-only metadata requests and discard stale generations.
3. Let the DSH manager own package locking, compatibility, rollback, and package logs.
4. Treat a manager success as an intermediate package state until Host and Client activation settle.
5. If activation is unsupported or ambiguous, show `restart-required` or `activation-unknown` and provide a native-manager next step.
6. Preserve the last successful check result while a refresh is in flight; do not show an empty settings panel.

## 6. Correctness properties

### 6.1 Exact-target integrity

For any accepted update operation, the installed target SHALL equal the exact version reviewed by the user. A later channel result or GitHub tag cannot silently change the target during confirmation.

**Validation:** Requirements 2, 3, and 5; check/apply correlation tests.

### 6.2 Activation truthfulness

For any result labeled `applied-without-desktop-restart`, both Host and Client activation states SHALL be active for the target version. No installation-only or one-sided activation result may use that label.

**Validation:** Requirement 6; activation-state matrix tests.

### 6.3 Ownership safety

For any mutating request from a non-owner or remote context, no DSH package-manager operation SHALL be invoked.

**Validation:** Requirement 8; owner/peer rejection tests.

### 6.4 Runtime identity safety

For any target replacement, the system SHALL use the DSH-supported lifecycle path or report restart-required. It SHALL never create a second live Codingns4DSH identity by cache-busting imports.

**Validation:** Requirement 7; capability adapter contract tests and static dependency checks.

## 7. Test strategy

### 7.1 Unit tests

- Parse npm dist-tags, exact manifests, publication dates, `gitHead`, engines, and peer constraints.
- Compare stable and prerelease versions using semver, including the case where `latest` is older than `next`.
- Parse and bound GitHub release records; reject wrong tags and oversized or unsafe bodies.
- Derive compatibility and final activation results from all combinations of package, Host, and Client states.
- Validate RPC inputs, owner checks, stale operation IDs, and fixed package/repository allowlists.

### 7.2 Integration tests

- Fake npm and GitHub endpoints with matching and mismatching versions/tags.
- Fake DSH Plugin Manager results for success, rollback, incompatibility, cancellation, and restart-required.
- Fake Host and Client activation capabilities for applied, partial, unsupported, and failed outcomes.
- Client settings-store tests for coalescing, stale responses, operation recovery, and disposal.
- Host status-revision and cancellation-race tests, including manager advancement while cancellation fails and recovery after transient polling failures.

### 7.3 End-to-end tests

- Static settings DOM fixtures for current version, channel selection, release notes, confirmation, progress, and restart-required states.
- Chromium acceptance with real loopback HTTP RPC, the production settings component and Host feature, injected metadata responses, and a fake official manager. This covers confirmation, authorization, offline state, page-reload recovery, cancellation, truthful activation results, and mobile overflow.
- `pnpm run test:isolated` copies the checkout and dependencies into a disposable POSIX workspace, uses separate HOME/DSH/cache/browser-profile directories and a clean child environment, then runs static checks, production builds, compiled tests, and tarball smoke checks. Set `QUICK_APPS_BROWSER_BIN` explicitly to include browser acceptance; `--focused` selects the updater tests.
- No live Desktop or DSH profile operation as part of ordinary repository verification.
- A separately authorized environment test may verify the official DSH bridge after the capability contract is implemented; it is not required for source-level acceptance.

### 7.4 Verification mapping

| Requirement | Design sections | Verification |
| --- | --- | --- |
| Requirement 1 | §3.2, §4.1 | Version-state contract and settings tests |
| Requirement 2 | §3.2.1, §3.4, §4.2 | Channel and semver tests |
| Requirement 3 | §3.4, §5.2 | Exact-tag and sanitization tests |
| Requirement 4 | §2.3, §3.2.3 | Compatibility matrix and manager rejection tests |
| Requirement 5 | §2.1, §3.3.2 | Owner and manager-adapter integration tests |
| Requirement 6 | §4.3, §6.2 | Activation truth-table and browser fallback tests; actual Desktop live activation remains blocked |
| Requirement 7 | §2.3, §6.4 | Capability boundary and lifecycle tests |
| Requirement 8 | §3.3.2, §5.3 | Owner/peer authorization tests |
| Requirement 9 | §4.2, §5.3 | Failure, revision/cancellation races, disposal, and offline browser tests |

## 8. Risks and open items

### 8.1 Risks

- The DSH Plugin Manager documentation at `master` may be newer than the exact runtime package used by a supported DSH version; the adapter must be release-pinned and capability-probed.
- DSH Web HMR and DSH Desktop package activation are different paths. Web HMR evidence cannot establish Desktop behavior.
- Replacing a package while old Host code remains in an ESM cache can leave stale registrations or duplicate services; private cache manipulation is explicitly prohibited.
- GitHub release notes and npm metadata are external dependencies and may be unavailable, rate-limited, or temporarily inconsistent.
- A package may be installed successfully but fail to activate because of a changed dependency mapping, missing build approval, or unsupported profile lifecycle.

### 8.2 Open items

- Package-manager signatures were verified in the published `@deepseek-ai/dsh-plugin-manager@0.2.1-rc.2` archive. The stable `plugin.update.*` names belong to CodingNS, not upstream DSH. See `docs/调查报告/20261025-插件更新接口与实现边界.md`.
- Confirm whether the target Desktop shell can reload the Client bundle and Host composition without restarting the Desktop application.
- Confirm whether the Desktop bridge can return independent Host and Client activation evidence rather than only a package-install result.
- Confirm whether a native Desktop Plugins page can be opened or linked from the Codingns4DSH settings panel without directly operating the Desktop profile.

### 8.3 Implemented release boundary

The verified manager has no `updateBundle` or `listVersions` methods. `installBundle` rejects an existing dependency with `already-installed` while HMR is mounted. The updater never works around this by removing its own bundle or touching profile files.

The supported adapter uses `installBundle(packageName + '@' + exactVersion, { enabled: true, saveExact: true, registry, requestId })` only for a known profile where replacement is permitted. It maps the manager's accepted bundle/version and lifecycle result separately. HMR, Desktop, packaged-shell, and unknown profiles receive explicit fallback diagnostics.

Compatibility evaluation intentionally recognizes a bounded grammar of complete semantic-version comparators, disjunctions, caret, and tilde ranges. Unknown syntax and missing declarations block updates rather than borrowing the running package's compatibility. DSH prereleases are ordered explicitly.

The Client renders release notes as escaped text. It does not use an HTML/Markdown execution path. Polling is serialized and pauses on hidden pages or errors; an explicit status refresh recovers it. Late checks, runtime reads, recovery reads, and cancellation responses cannot overwrite newer state.

