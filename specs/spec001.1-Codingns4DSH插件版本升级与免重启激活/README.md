# Spec001.1: Codingns4DSH Plugin Updates and No-Desktop-Restart Activation

Status: Repository implementation and isolated build, package, and browser verification complete for metadata, settings, and supported manager delegation. The latest layout correction passed all 65 focused cases. The last full compiled run had 4,006 passes, one pre-existing failure, and 29 skips. Desktop live activation and final Spec acceptance remain blocked by the missing upstream contract.

This Spec is a child of [Spec001: Codingns4DSH as a single DSH plugin](../spec001-DeepSeekHarness-Codingns4DSH单一插件/README.md). It defines how Codingns4DSH can show available package updates, obtain release notes from the matching GitHub tag, request an update from the DSH-owned package manager, and report whether the new Host and Client code is actually active.

The central rule is that package installation and runtime activation are separate facts. The settings page must never claim that an update is live merely because npm installation succeeded.

## Documents

- [Requirements](requirements.md)
- [Design](design.md)
- [Tasks](tasks.md)
- [Supplementary documents](docs/README.md)
- [20261025 feasibility investigation](../../docs/调查报告/20261025-Codingns4DSH插件更新与免重启激活可行性调查.md)
- [Release-pinned contract evidence](../../docs/调查报告/20261025-插件更新接口与实现边界.md)
- [Implementation and verification record](../../docs/开发记录/20261025-Spec001.1插件更新开发记录.md)

## Scope

- Compare the running or installed Codingns4DSH version with a selected npm distribution channel.
- Distinguish stable `latest`, prerelease `next`, and explicitly selected versions.
- Resolve release notes from the exact GitHub tag for the selected package version.
- Display compatibility, publication, commit, release-note, and update-application state in the Codingns4DSH settings.
- Delegate package replacement to an official DSH Plugin Manager or Desktop-owned bridge when one is available.
- Confirm Host activation and Client resource reload independently before claiming a no-Desktop-restart update.
- Provide an honest `restart-required` fallback when the current DSH runtime cannot replace one or both halves in memory.

## Out of scope

- Running `npm`, `pnpm`, or `dsh plugin` directly from Codingns4DSH.
- Editing the Desktop profile, `node_modules`, lockfiles, caches, or plugin directories from the plugin.
- Evicting Node ESM cache entries with private loader internals or cache-busting imports.
- Promising that DSH Desktop can update and activate arbitrary Host and Client code without a supported DSH shell capability.
- Updating the DSH application itself.
- Operating, installing into, or restarting DSH Desktop as part of repository verification.

## Decision summary

1. Version discovery and GitHub release-note display are implementable in the Codingns4DSH settings flow.
2. Package replacement must use a DSH-owned capability because the DSH Plugin Manager owns profile package operations and Desktop package operations are owned by the Desktop shell.
3. DSH HMR may apply replaceable plugins in supported Web profiles, but Web Client HMR is not evidence of Desktop Host and Client activation.
4. A successful implementation must return separate `installed`, `hostActivated`, and `clientReloaded` facts. Only the combination of all required live facts may produce `applied-without-desktop-restart`.

## Implemented behavior

The version information in the top settings banner is the updater entry. Clicking the version expands update details; a new-version label appears beside it when the checked target is newer than the loaded and installed versions. One bounded check runs when the visible settings page opens. There is no separate updater module card or switch.

The original brand/message/GitHub row is preserved. A compact `New` label uses reserved space beside the original version pill, so its appearance cannot widen the brand column or move the message and GitHub button. Hovering the label shows the full target version.

The expanded details check the selected npm channel and display the matching GitHub tag and bounded release notes. They expose running Host, running Client, and installed package versions separately, even when npm is offline. All updater strings follow the active DSH locale; Chinese uses the registered `zh` dictionary and localized dates. The panel uses compact version cards, highlighted status/target/confirmation sections, and a bounded monospace release-notes area. Collapsing preserves channel and operation state.

An explicitly confirmed compatible update can use the official manager on the verified non-HMR profile path. On DSH 0.2.1-rc.2, HMR profiles reject in-place replacement of an installed package; the card therefore directs the user to native Plugins. Desktop and unknown compositions also receive an explicit fallback. No production path currently claims a no-Desktop-restart update.

`pnpm run test:isolated` runs static checks, production builds, compiled tests, and npm tarball smoke checks in a disposable POSIX copy. Set `QUICK_APPS_BROWSER_BIN` to a headless Chromium executable for browser acceptance; `--focused` selects updater/browser, settings-banner, and Client-entry regressions. The header integration passed all 65 focused cases. The full follow-up run had 4,006 passes, one failure, and 29 skips. Its only failure remains the existing defaults expectation in `tests/contracts.spec.ts`, which omits the committed `sessionHandleEviction` field.

Browser acceptance uses real settings/RPC code with fixture metadata and a fake manager. It does not establish actual DSH installation or live Desktop activation. Exact commands, artifacts, and remaining limits are recorded in `docs/开发记录/20261025-Spec001.1插件更新开发记录.md`.

