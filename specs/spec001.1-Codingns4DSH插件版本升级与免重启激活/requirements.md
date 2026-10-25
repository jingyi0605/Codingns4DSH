# Requirements - Codingns4DSH Plugin Updates and No-Desktop-Restart Activation

Status: Repository implementation verified for metadata, settings, and supported manager delegation. Actual Desktop live activation remains blocked; final acceptance is tracked in `tasks.md`.

## Introduction

Codingns4DSH is distributed as one DSH Bundle with separate Host and Client entrypoints. Users currently have to replace the installed package manually and restart the DSH instance; the repository README documents that installation or upgrade requires a restart.

Users need a settings experience that answers three different questions without conflating them:

1. Is a newer Codingns4DSH package available?
2. What changed in that exact release?
3. After an update, is the new Host and Client code running now, or is a restart still required?

## Glossary

- **System**: The Codingns4DSH Host and Client running inside DSH.
- **Running version**: The version of the code currently loaded in the Host or Client process.
- **Installed version**: The package version selected or installed in the active DSH profile.
- **Update target**: The exact package version selected for installation.
- **Stable channel**: The npm `latest` dist-tag.
- **Prerelease channel**: The npm `next` dist-tag. It is not assumed to be newer than `latest` without semver comparison.
- **Release notes**: The body of the GitHub release associated with the exact `v<version>` tag.
- **Host activation**: The DSH Host has unloaded or replaced the old Codingns4DSH Host contribution and reports the target version as active.
- **Client reload**: The DSH Client has fetched and mounted the target Client bundle or otherwise reports that the target Client code is active.
- **Desktop restart**: Restarting the DSH Desktop application or its owning Desktop shell. A page reload or a supported Host-only lifecycle operation is not automatically equivalent to a Desktop restart.

## Scope

### In scope

- npm metadata lookup and channel selection.
- Exact GitHub tag and release lookup.
- DSH compatibility inspection before an update.
- Settings UI for checking, reviewing, confirming, and observing an update.
- Host RPC boundaries for read-only metadata and update operations.
- DSH-owned package-manager delegation.
- Separate Host and Client activation reporting.
- Safe fallback to `restart-required`.

### Out of scope

- DSH application updates.
- Direct package-manager subprocesses owned by Codingns4DSH.
- Direct Desktop profile or filesystem manipulation.
- Private ESM cache eviction, arbitrary re-imports, or duplicate Cordis service identities.
- Automatic Desktop operation during development, testing, or release verification.

## Requirements

### Requirement 1: Show the installed and running version state

**User story:** As a user, I want to know which Codingns4DSH code is running and which package is installed before I decide to update.

#### Acceptance criteria

1. WHEN update details are expanded from the header version control THEN System SHALL show the running Host version, running Client version when available, and installed profile version when the DSH manager exposes it.
2. WHEN the running and installed versions differ THEN System SHALL show them as separate values and SHALL NOT silently present the installed version as active code.
3. WHEN the package metadata is unavailable THEN System SHALL show an explicit unknown state rather than infer the version from a file path or a stale UI constant.
4. System SHALL integrate update details with the existing version information at the top of Codingns4DSH settings rather than expose a separate module card or enable/disable switch.
5. Clicking the header version SHALL expand or collapse update details. A checked target newer than the loaded and installed versions SHALL display a new-version label beside the current version, including while details are collapsed.
6. The original brand/message/GitHub layout SHALL remain intact. Showing or hiding the new-version label, including for a long target version, SHALL not change header column positions, version-pill dimensions, or banner height.

### Requirement 2: Check a clearly selected npm channel

**User story:** As a user, I want to check a stable or prerelease channel without the updater silently choosing a different release train.

#### Acceptance criteria

1. WHEN the user selects the stable channel THEN System SHALL resolve the npm `latest` dist-tag.
2. WHEN the user selects the prerelease channel THEN System SHALL resolve the npm `next` dist-tag.
3. WHEN the user selects an exact version THEN System SHALL inspect that exact version and SHALL not replace it with a dist-tag result.
4. WHEN a channel target is older than the current version under semver ordering THEN System SHALL report `no-newer-version` and SHALL not present it as an update.
5. WHEN the selected channel is missing or the registry is unavailable THEN System SHALL preserve the previous result and show a retryable error.

### Requirement 3: Display release notes from the exact GitHub tag

**User story:** As a user, I want to review what changed in the exact package version before confirming an update.

#### Acceptance criteria

1. WHEN an npm target version is selected THEN System SHALL request the matching GitHub tag `v<version>` from the configured Codingns4DSH repository.
2. WHEN the tag and release exist THEN System SHALL show the release title, publication date, commit identity, and sanitized release body.
3. WHEN the tag exists but no GitHub release body exists THEN System SHALL show the exact tag and commit and SHALL state that release notes are unavailable.
4. WHEN the target tag does not exist THEN System SHALL not substitute the repository default branch or an unrelated release; it SHALL show a missing-release-notes state.
5. WHEN release-note content contains HTML, scripts, oversized text, or unsupported markup THEN System SHALL render bounded safe text or links only.

### Requirement 4: Check DSH compatibility before installation

**User story:** As a user, I want the updater to reject a package that is incompatible with the running DSH before changing the profile.

#### Acceptance criteria

1. WHEN npm metadata declares `engines.dsh` or relevant DSH peer constraints THEN System SHALL compare them with the running DSH version before offering an update action.
2. WHEN the target is incompatible THEN System SHALL disable or block the update action and SHALL explain the incompatible requirement.
3. WHEN compatibility cannot be determined THEN System SHALL not claim that the target is safe; it SHALL require the official DSH manager to perform an authoritative check or report `compatibility-unknown`.
4. WHEN the official manager rejects the target during its own compatibility check THEN System SHALL preserve that rejection and SHALL not bypass it with a direct package operation.

### Requirement 5: Update only through a host-owned package operation

**User story:** As a user, I want a confirmed update to use the same locking, compatibility, rollback, and profile rules as the official DSH package manager.

#### Acceptance criteria

1. WHEN the user confirms an update THEN System SHALL call an official DSH Plugin Manager or Desktop-owned update capability through the Host boundary.
2. System SHALL NOT execute a package-manager subprocess, edit profile manifests, write lockfiles, replace `node_modules`, or copy tarballs from the Client.
3. WHEN no supported host-owned update capability is available THEN System SHALL disable one-click update and provide the native DSH Plugins action or manual instruction instead.
4. WHEN the package manager reports progress, cancellation, rollback, or failure THEN System SHALL expose the corresponding state without claiming success early.
5. WHEN an update operation is already running THEN System SHALL prevent a second operation for the same package and target.

### Requirement 6: Report activation separately from installation

**User story:** As a user, I want to know whether the new package is actually running, not merely downloaded.

#### Acceptance criteria

1. WHEN package installation completes THEN System SHALL report the installed target version separately from Host and Client activation.
2. WHEN Host activation succeeds but Client reload is not confirmed THEN System SHALL report a partial or pending state and SHALL not claim that the update is fully active.
3. WHEN Client reload succeeds but Host activation is not confirmed THEN System SHALL report a partial or pending state and SHALL not claim that the update is fully active.
4. WHEN both Host activation and Client reload are confirmed by supported DSH capabilities THEN System SHALL report `applied-without-desktop-restart`.
5. WHEN either side reports `restart-required`, `not-supported`, or an unconfirmed state THEN System SHALL report `restart-required` or `activation-unknown` and SHALL give the user the required next step.

### Requirement 7: Preserve runtime safety during replacement

**User story:** As a user, I want an update to avoid duplicate registrations, stale module graphs, and half-applied plugin state.

#### Acceptance criteria

1. System SHALL use the DSH lifecycle and HMR contracts for unloading, loading, and Client replacement when those contracts are available.
2. System SHALL not use private ESM loader internals, cache-busting imports, or duplicate package identities to force a reload.
3. WHEN replacement fails during validation, loading, or activation THEN System SHALL preserve the manager's rollback or failure result and SHALL show the actual remaining state.
4. WHEN the old code remains loaded after package replacement THEN System SHALL clearly distinguish disk/profile state from live runtime state.

### Requirement 8: Restrict privileged update actions

**User story:** As a Host owner, I want only an authorized local owner operation to change the installed plugin.

#### Acceptance criteria

1. WHEN an update request arrives from a non-owner, peer, relay, or remote Web context THEN System SHALL reject it before package-manager invocation.
2. System SHALL not place credentials, approval tokens, profile paths, or package-manager logs in Client responses.
3. System SHALL validate package name, version, registry URL, tag, and GitHub repository against fixed allowlists before network access.
4. System SHALL make user confirmation explicit before any mutating update operation.

### Requirement 9: Keep settings usable when update services fail

**User story:** As a user, I want the rest of Codingns4DSH settings to remain usable when npm, GitHub, or the DSH manager is unavailable.

#### Acceptance criteria

1. WHEN update metadata lookup fails THEN System SHALL keep existing module settings and native DSH behavior available.
2. WHEN an update operation fails THEN System SHALL leave the settings panel usable and SHALL show a retry or native-manager fallback.
3. WHEN the updater is unsupported by the current DSH version THEN System SHALL show an explicit capability diagnostic rather than a generic network error.
4. WHEN the settings panel or Client feature is disposed THEN System SHALL cancel polling, progress subscriptions, and pending UI updates.

## Non-functional requirements

### Performance

1. Metadata checks SHALL run once when the visible settings page is opened and on explicit request. An initially hidden page SHALL defer its first metadata check until visible; the settings page SHALL not poll npm or GitHub continuously.
2. Concurrent checks for the same package, channel, and registry SHALL be coalesced.
3. Update progress SHALL be streamed or sampled through the official manager without unbounded Client-side buffering.

### Reliability

1. A late metadata, progress, or activation response SHALL not overwrite a newer check or a different target.
2. A successful package write without activation confirmation SHALL remain visibly pending until a supported status check settles.
3. All failure states SHALL retain enough structured data to distinguish compatibility failure, package failure, activation failure, and restart requirement.

### Maintainability

1. npm, GitHub, DSH manager, and Desktop bridge details SHALL remain behind Host-side adapters and capability routes.
2. Business code SHALL not import DSH version-specific manager types directly or scatter version checks through the settings UI.
3. The update contract SHALL be testable with fake npm, GitHub, Plugin Manager, Host, and Client capability implementations.

## Success definition

- The settings UI can identify a target version from a selected npm channel and show release notes from the exact GitHub tag.
- A compatible update is delegated to an official host-owned package operation after explicit confirmation.
- The UI distinguishes installed, Host-active, and Client-active state.
- The system never claims a no-Desktop-restart update without independent Host and Client activation evidence.
- Unsupported Desktop or DSH versions fall back to a clear `restart-required` or native-manager instruction.
- Focused tests cover channel comparison, release-note matching, compatibility, ownership, operation outcomes, activation states, stale responses, and cleanup.

