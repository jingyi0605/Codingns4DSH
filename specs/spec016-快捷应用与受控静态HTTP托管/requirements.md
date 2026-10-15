# Requirements — Quick Apps and controlled static HTTP hosting

Status: Draft, 2026-10-15.

## Introduction

The membership HTML page runs inside DSH's isolated document preview. A phone directory picker cannot provide access to files on the computer hosting the workspace. The existing page-specific connector supplies some file operations, but it does not serve ordinary websites over HTTP.

Users need to select a workspace, application folder, and entry HTML, then open that application from Quick Apps on Desktop or a phone. Static resource loading must use browser HTTP behavior. Saving workspace data is an optional, explicitly scoped capability.

## Terms

- **Host**: the computer or remote DSH instance that owns the files.
- **Shortcut**: a persistent reference to a Host, workspace, and entry file; never a copy of that file.
- **Document root**: the approved directory mapped to the application's URL root.
- **Mount**: an additional approved workspace directory exposed at an application URL path.
- **Launch session**: temporary Host-owned authorization for one application launch.
- **Grant**: allowed operations and paths, stored and checked by the Host.

## Scope

In scope: shortcut management, HTML and text opening, static HTTP(S) resources, optional SPA navigation fallback, Host/workspace isolation, optional text-file writes, and Desktop/phone compatibility through supported connections.

Out of scope: starting arbitrary development servers; Node/Python/PHP/SSR execution; npm builds per app; a general reverse proxy; public anonymous sharing; automatic app migration; filesystem watching; service-worker/offline lifecycle management; installing or restarting a running DSH instance. Existing backend APIs continue to require their own reachable, authorized service.

## R1 — Manage shortcuts from managed workspaces

**User story:** As a user, I want to add HTML and text files from managed workspaces so I can open them without finding a conversation first.

1. WHEN adding a shortcut, the system SHALL validate its owning Host, workspace, entry file, and document root; the entry SHALL be inside the approved root.
2. WHEN reopening DSH from another client of the same controlling Host/profile, the system SHALL load the persisted shortcut list, retaining remote Host identity and ordering.
3. WHEN no conversation is active, the shortcut SHALL remain openable through workspace identity alone.
4. WHEN a shortcut is removed, the system SHALL leave source files intact. Missing files, missing workspaces, and disconnected Hosts SHALL have distinct unavailable states.

## R2 — Serve ordinary static applications

**User story:** As an app author, I want standard HTML resources to work through HTTP without adopting a required proprietary SDK.

1. WHEN loading an app, the system SHALL provide real HTTP(S) URLs for HTML, classic scripts, ES modules, dynamic imports, CSS imports, images, fonts, and data fetched by relative URL, subject to approved roots and mounts.
2. WHEN requesting a resource, the system SHALL support GET and HEAD, correct MIME types, Unicode/space-containing paths, query strings, directory index redirects, and correct missing-resource responses.
3. WHEN the app uses root-relative paths such as `/assets/main.js`, the app origin SHALL resolve them against its own document root. A path-prefix compatibility mode SHALL explicitly disclose base-path requirements and SHALL NOT be represented as equivalent support.
4. WHEN SPA fallback is enabled, only eligible HTML navigation requests SHALL fall back to the entry file; missing scripts, styles, data requests, and reserved API paths SHALL remain errors.
5. WHEN serving app source, the system SHALL preserve source bytes unless the user enables a specific compatibility transformation. Normal static hosting SHALL NOT require SDK injection or Blob packaging.

## R3 — Enforce Host, workspace, and origin boundaries

**User story:** As a workspace owner, I want an app to access only the resources I approved.

1. WHEN serving any file or performing any mutation, the Host SHALL resolve the launch session to its own app definition, workspace root, grants, and revision. Request parameters SHALL NOT replace those identities or enlarge grants.
2. WHEN an app is launched, its executable origin SHALL be distinct from DSH's privileged UI. Apps with different grants SHALL have separate origins; a URL path prefix alone SHALL NOT count as origin isolation.
3. WHEN a launch expires, is revoked, or its relevant app configuration changes, subsequent requests SHALL be rejected. Disabling the module SHALL close routes and active launch sessions. Persisted shortcuts SHALL survive; revoked launch credentials SHALL not be revived after restart.
4. WHEN resolving files, the system SHALL reject traversal, malformed/ambiguous encodings, root escapes, and symlink escapes; it SHALL not expose arbitrary workspace files, `.git`, or secret files merely because the entry belongs to that workspace.
5. WHEN authorizing app requests, the system SHALL keep general DSH credentials in the privileged Host/client boundary. App credentials SHALL be limited to their launch scope and omitted from logs and referrers.

## R4 — Offer optional file writes

**User story:** As a user of a static data-management app, I want approved changes saved to its Host workspace.

1. WHEN only static access is enabled, write and delete requests SHALL fail. Static GET/HEAD SHALL not mutate workspace files.
2. WHEN write access is enabled, the Host SHALL check separate read, write/create, and delete permissions for each path. The app SHALL use a documented HTTP API; a JavaScript SDK MAY wrap it but SHALL remain optional.
3. WHEN updating or deleting an existing file, the request SHALL include a version precondition and stale requests SHALL fail without silently overwriting newer content. Creating a new file SHALL not overwrite an existing file.
4. WHEN saving, the system SHALL bound request size, serialize its own mutations, revalidate authorization/path state at execution, and use atomic replacement. External applications do not participate in plugin locks; that limitation SHALL be documented.
5. WHEN a write fails, the app SHALL receive a clear error and keep its edited content available for retry or export. A successful workspace save SHALL not be reported as a browser download.

## R5 — Work through supported Desktop and phone connections

**User story:** As a phone user, I want the shortcut to open and save on the correct computer without selecting phone storage.

1. WHEN generating an app URL, the system SHALL use a browser-reachable endpoint appropriate to the current connection, preserving the owning Host. A remote browser SHALL not receive a computer-only loopback URL.
2. WHEN the containing DSH page uses HTTPS, embedded app resources SHALL use a compatible HTTPS route; the system SHALL not silently downgrade to mixed-content HTTP.
3. WHEN the required origin/routing capability is unavailable, the UI SHALL explain that limitation before launch instead of weakening isolation or showing a falsely connected state.
4. WHEN accessing a PeerHost workspace, resource and file API requests SHALL reach that Host; mismatched and disconnected targets SHALL fail closed. Unsupported relay compositions SHALL be reported explicitly.

## R6 — Integrate through supported plugin interfaces

**User story:** As a plugin user, I want Quick Apps to coexist with existing file management and ordinary previews.

1. WHEN enabled, the module SHALL register its entry through the sidebar footer slot and expose a usable narrow-screen launcher. It SHALL not replace the native sidebar.
2. WHEN opening text/Markdown, the system SHALL use an appropriate document viewer without executing the text as HTML. A workspace with no session SHALL still be supported by the plugin-owned view.
3. WHEN a DSH capability is missing or version-incompatible, the module SHALL report a bounded capability diagnostic through the existing capability registry.
4. WHEN migrating the earlier HTML connector, existing behavior SHALL be preserved or explicitly retired with a replacement. Unrelated translation changes SHALL not be included in this feature's implementation or commits.

## Non-functional requirements

- Resource serving must support binary bytes without UTF-8 corruption, bounded streaming, request cancellation, and cleanup of route registrations and session resources.
- The initial defaults are 4 MiB per text API request and a bounded number of concurrent requests per launch; exact resource limits must be recorded with evidence in design task T1.
- Version-sensitive services and DOM fallbacks belong in `src/dsh-capabilities/`, not application modules. UI strings use the existing English/Chinese dictionaries.
- No polling or watcher subsystem is required. Expiry is checked on access; ordinary resource caching must not bypass revocation checks.

## Success definition

A standard multi-file fixture opens unchanged from Quick Apps with no active conversation; ordinary module imports and data fetches work; a phone-reachable fixture saves to the intended Host only after grant approval; stale writes and cross-app/workspace requests fail. The membership page is a compatibility fixture, not the only supported application. Passing the legacy connector tests alone does not satisfy this Spec.
