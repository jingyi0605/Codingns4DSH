# Requirements: External Agent installation and updates

Status: Accepted

## Scope

Extend the existing settings page and Host CLI feature. Preserve detection, enablement, model selection, sessions, and remote Host read-only behavior.

## R1: State-dependent actions

As a user, I want to install missing Agents and update installed Agents without finding commands myself.

1. A completed missing detection shows Install. An installed Agent shows Update only after a comparable newer publisher release is confirmed, even when disabled or disconnected. Unknown, current, checking, and failed checks do not show Update.
2. Pending or failed detection cannot be treated as a confirmed missing installation.
3. Install previews the Host-selected official installer. Clicking Update starts the verified updater directly, then shows progress and cancellation with command details available on demand. Neither action presents an installation-method chooser.
4. Detect ownership from the executable, symlinks, and package metadata. Preserve the package manager and installation location. Identified ZCode desktop bundles on Windows/macOS update the owning app in place using its official release package. Unidentified installations, other application-managed runtimes, package-managed ZCode bundles, and migrations show guidance and a re-detect action without asking users to identify their installation method.
5. Repeated detection, opening or closing progress, and completion refreshes retain exactly one row per registered Agent. Sibling rows and dialogs must have distinct React keys.

## R2: Official methods

As a user, I want the action to follow the Agent publisher's documented method for my Host platform.

1. All 18 registered adapters have official installation/update information, including separate Qoder and Qoder CN entries.
2. Run only fixed Host-owned commands. The browser supplies adapter, action, and method identifiers, never shell text.
3. Desktop installers without a verified update path, interactive-only operations, unsupported platforms, and unverified methods show official guidance rather than an invented command. ZCode desktop updates verify the official manifest's package size and SHA-512 checksum before executing the Windows installer or replacing the macOS bundle.
4. Legacy distribution migrations are explained and are not silently performed as routine updates.

## R3: Reliable execution and feedback

As a user, I want to see progress, errors, and the detected result.

1. At most one management command runs per Host; duplicate requests cannot launch duplicate installers.
2. Reject management while the affected adapter is executing; reject new turns while it is being managed.
3. Commands have bounded output, a timeout, cancellation, and feature-disposal cleanup. Display output in a scrollable terminal with automatic following that pauses when the user scrolls up. Distinguish running, success, failure, and cancellation with icons, labels, and color.
4. Re-detect after completion and invalidate model caches. After success, immediately show the verified version and call `catalog/refresh` with release checking for that Agent. Keep update success distinct from a failed list refresh and allow retrying only the refresh. Exit zero without a detected installation, or without a newer version after an update, is reported as a verification failure.
5. Settings re-opening can recover the latest operation; changing Hosts cannot apply late results to the new Host. Closing only the progress dialog keeps completion tracking active while the Agent list remains mounted, including retries after transient status errors.
6. Tests use fake commands and adapters, with no live installations or Desktop changes.

## R4: Refresh-driven background release checks

1. Existing single-Agent and list refresh buttons refresh detection and request release checks for the selected Host. Loading the list does not initiate network checks.
2. Version checks run asynchronously, with bounded concurrency, response sizes, and timeouts. They never run an installer, update command, authentication flow, or Agent session.
3. Return catalog data without waiting for release checks; show progress through the existing refresh icons and stop polling when checks settle.
4. Failed, unsupported, or ambiguous checks remain distinguishable from current versions. A later refresh retries them. Installation changes and late responses cannot reuse stale availability.
5. Resolve package identity in the background when needed. Keep Pi's actual npm package, CodeBuddy's npm/native sources, and Claude's Homebrew cask channel aligned with the updater. Do not classify all Pi 0.x versions as a legacy distribution.
6. Check the public stable application manifest for identified ZCode bundled runtimes. Windows/macOS bundles with a supported in-place updater expose the regular Update action; remaining layouts retain the app-managed label. Read the installed app's package version on re-detection rather than requiring the app to launch and refresh its provider snapshot. Explain remaining manual-check reasons; malformed metadata from a configured feed is an error.

## R5: Dense responsive settings

1. Install and Update are icon buttons with accessible labels, tooltips, keyboard focus, and touch targets.
2. Remove the nested list card, oversized logo tiles, redundant enabled text, and missing-version placeholder. Keep Host selection, status, versions, detection, and enablement accessible.
3. Keep rows compact on mobile and adapt very narrow panels without horizontal overflow. Preserve theme colors and reduced-motion preferences.
4. Delegation enablement and concurrency remain in their original settings position above one Agent-list entry. Only the Agent list opens in an independent modal outside settings containment, wide on desktop and full-screen on mobile. Nested management/details dialogs retain independent focus and dismissal.
5. Install and Update use the refresh control's transparent icon-button style; Install is blue and Update is green.
6. Unchecked, failed, and manual-only release checks remain visible. A Host that omits update-check support must produce an actionable compatibility message instead of silently hiding every Update button.
