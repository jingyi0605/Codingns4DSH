# Requirements — Quick Apps and controlled static HTTP hosting

Status: Implemented with platform acceptance pending; workspace-access policy amended by the user on 2026-10-16.

Browser-storage amendment (2026-10-17): R7 adds the documented asynchronous API and LocalStorage/SessionStorage compatibility to the default sandbox viewer. Native browser storage remains inaccessible to app code; IndexedDB remains excluded. This supersedes earlier blanket storage exclusions only within R7's scope.

Transport amendment (2026-10-16): the user selected sandboxed previews through the existing DSH Host address. This is the default on supported Hosts and supersedes separate app addresses as a setup requirement. Opaque sandbox isolation replaces distinct URL origins in this mode; browser storage and unchanged root-relative URLs are explicitly outside its compatibility guarantee. See `specs/spec016-快捷应用与受控静态HTTP托管/docs/20261016-主机代理预览与局域网回归修复.md`.

The user selected read/write/create/delete access within the shortcut's owning workspace as the default for newly added HTML apps. This supersedes the original per-path approval default. Existing shortcuts keep their earlier behavior until explicitly saved with workspace access. Browser origin isolation, exact owning-Host routing, path containment, version preconditions and cleanup remain required.

## Introduction

The membership HTML page runs inside DSH's isolated document preview. A phone directory picker cannot provide access to files on the computer hosting the workspace. The existing page-specific connector supplies some file operations, but it does not serve ordinary websites over HTTP.

Users need to select a workspace, application folder, and entry HTML, then open that application from Quick Apps on Desktop or a phone. Static resource loading must use browser HTTP behavior. Saving a new HTML shortcut authorizes its workspace file operations through the optional HTTP API.

## Terms

- **Host**: the computer or remote DSH instance that owns the files.
- **Shortcut**: a persistent reference to a Host, workspace, and entry file; never a copy of that file.
- **Document root**: the approved directory mapped to the application's URL root.
- **Mount**: an additional approved workspace directory exposed at an application URL path.
- **Launch session**: temporary Host-owned authorization for one application launch.
- **Grant**: allowed operations and paths, stored and checked by the Host.

## Scope

In scope: shortcut management, HTML and text opening, static HTTP(S) resources, optional SPA navigation fallback, Host/workspace isolation, optional text-file writes, application-scoped browser storage under R7, and Desktop/phone compatibility through supported connections.

Out of scope: starting arbitrary development servers; Node/Python/PHP/SSR execution; npm builds per app; a general reverse proxy; public anonymous sharing; automatic app migration; filesystem watching; service-worker/offline lifecycle management; installing or restarting a running DSH instance. Existing backend APIs continue to require their own reachable, authorized service.

## R1 — Manage shortcuts from managed workspaces

**User story:** As a user, I want to add HTML and text files from managed workspaces so I can open them without finding a conversation first.

1. WHEN adding a shortcut, the system SHALL validate its owning Host, workspace, entry file, and document root; the entry SHALL be inside the approved root.
2. WHEN reopening DSH from another client of the same controlling Host/profile, the system SHALL load the persisted shortcut list, retaining remote Host identity and ordering.
3. WHEN no conversation is active, the shortcut SHALL remain openable through workspace identity alone.
4. WHEN a shortcut is removed, the system SHALL leave source files intact. Missing files, missing workspaces, and disconnected Hosts SHALL have distinct unavailable states.
5. WHEN changing shortcut order, the current Host SHALL persist the complete order atomically with revision checks. Reordering SHALL preserve open HTML/text viewers, existing grants, owning-Host routing and access policy; stale concurrent reorder requests SHALL fail without partial updates.

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
2. WHEN an app is launched through the default Host proxy, the iframe and HTTP response SHALL enforce an opaque sandbox origin, without `allow-same-origin`. Launch routes SHALL bind to separate Host-owned grants. A URL prefix alone SHALL NOT count as isolation. The retained dedicated-hosting mode SHALL keep separate URL origins for apps with different grants.
3. WHEN a launch expires, is revoked, or its relevant app configuration changes, subsequent requests SHALL be rejected. Display order and metadata revisions alone SHALL not invalidate a launch. Disabling the module SHALL close routes and active launch sessions. Persisted shortcuts SHALL survive; revoked launch credentials SHALL not be revived after restart.
4. WHEN resolving files, the system SHALL reject traversal, malformed/ambiguous encodings, root escapes, and symlink escapes. Saved workspace access SHALL cover ordinary files in the owning workspace through the file API; hidden/credential files remain excluded. Static URLs SHALL remain scoped to the app folder and configured mounts.
5. WHEN authorizing app requests, the system SHALL keep general DSH credentials in the privileged Host/client boundary. App credentials SHALL be limited to their launch scope and omitted from logs and referrers.

## R4 — Offer optional file writes

**User story:** As a user of a static data-management app, I want it to read and manage files in its owning workspace without configuring separate path lists.

1. WHEN adding an HTML shortcut through the current UI, saving SHALL authorize workspace read/write/create/delete access with a visible explanation. Existing shortcuts SHALL retain their prior access until the user explicitly saves workspace access. Static GET/HEAD SHALL not mutate files; revoked or legacy static-only launches SHALL have no implicit file API grant.
2. WHEN workspace access is saved, the Host SHALL derive all three operation scopes from the saved owning workspace, without per-path prompts or application-code reapproval. Revocation SHALL remove this persisted policy and invalidate launches. Legacy scoped grants SHALL remain compatible until deliberately migrated. Apps SHALL use the documented HTTP API; an SDK remains optional.
3. WHEN updating or deleting an existing file, the request SHALL include a version precondition and stale requests SHALL fail without silently overwriting newer content. Creating a new file SHALL not overwrite an existing file.
4. WHEN saving, the system SHALL bound request size, serialize its own mutations, revalidate authorization/path state at execution, and use atomic replacement. External applications do not participate in plugin locks; that limitation SHALL be documented.
5. WHEN a write fails, the app SHALL receive a clear error and keep its edited content available for retry or export. A successful workspace save SHALL not be reported as a browser download.

## R5 — Work through supported Desktop and phone connections

**User story:** As a phone user, I want the shortcut to open and save on the correct computer without selecting phone storage.

1. WHEN generating an app URL, the system SHALL use a browser-reachable endpoint appropriate to the current connection, preserving the owning Host. A remote browser SHALL not receive a computer-only loopback URL.
2. WHEN the containing DSH page uses HTTPS, embedded app resources SHALL use a compatible HTTPS route; the system SHALL not silently downgrade to mixed-content HTTP.
3. WHEN the required origin/routing capability is unavailable, the UI SHALL explain that limitation before launch instead of weakening isolation or showing a falsely connected state.
4. WHEN accessing a PeerHost workspace, resource and file API requests SHALL reach that Host; mismatched and disconnected targets SHALL fail closed. Unsupported relay compositions SHALL be reported explicitly.
5. WHEN opening a sandboxed preview, the system SHALL proxy through the current DSH address, using its existing HTTP or HTTPS transport without additional app certificates or exposed ports. Quick Apps configuration SHALL NOT restrict ordinary LAN navigation or break existing reverse proxies. Separate HTTPS ports remain an optional compatibility implementation, not the default setup requirement.

## R6 — Integrate through supported plugin interfaces

**User story:** As a plugin user, I want Quick Apps to coexist with existing file management and ordinary previews.

1. WHEN enabled, the module SHALL register its entry through the sidebar footer slot and expose a usable narrow-screen launcher. It SHALL not replace the native sidebar.
2. WHEN opening text/Markdown, the system SHALL use an appropriate document viewer without executing the text as HTML. A workspace with no session SHALL still be supported by the plugin-owned view.
3. WHEN a DSH capability is missing or version-incompatible, the module SHALL report a bounded capability diagnostic through the existing capability registry.
4. WHEN migrating the earlier HTML connector, existing behavior SHALL be preserved or explicitly retired with a replacement. Unrelated translation changes SHALL not be included in this feature's implementation or commits.

## R7 — Application-scoped browser storage (2026-10-17)

**User story:** As a Quick Apps user, I want each application to save data in my current browser without domain, certificate or port setup, while keeping DSH and other applications' data isolated.

1. New sandbox viewers SHALL offer `appStorage` with asynchronous string-key/value `getItem`, `setItem`, `removeItem`, `clear`, `keys` and `flush`; successful writes SHALL be acknowledged after the trusted browser store accepts them. `appStorage.session` SHALL use tab-session storage.
2. A documented LocalStorage/SessionStorage facade SHALL preload values before application scripts execute. Synchronous writes SHALL update a local mirror and queue persistence; errors SHALL remain observable through `flush()`, an application error event and the viewer.
3. Storage identity SHALL use the browser origin/profile and the Host's authoritative launch snapshot of the shortcut's owning Host, workspace, ID and source paths. Stale sidebar metadata SHALL NOT select a previous source's namespace. Display/order/revision changes SHALL preserve data; changing source identity SHALL select a different namespace. App messages SHALL NOT choose storage namespaces.
4. The iframe and response SHALL retain opaque-origin sandboxing. A per-launch token, exact source window and transferred MessagePort SHALL bind the bridge; nested/foreign windows, malformed requests, expired/disposed channels and excessive data SHALL be rejected.
5. No new domain, certificate, listener, Host-side business-data storage or workspace grant SHALL be required. Older viewers/Hosts and dedicated-origin providers SHALL retain their previous behavior. IndexedDB, storage events, live cross-window mirror synchronization, workers and native Storage object branding SHALL remain outside this increment.

## Non-functional requirements

- Resource serving must support binary bytes without UTF-8 corruption, bounded streaming, request cancellation, and cleanup of route registrations and session resources.
- The initial defaults are 4 MiB per text API request and a bounded number of concurrent requests per launch; exact resource limits must be recorded with evidence in design task T1.
- Version-sensitive services and DOM fallbacks belong in `src/dsh-capabilities/`, not application modules. UI strings use the existing English/Chinese dictionaries.
- No polling or watcher subsystem is required. Expiry is checked on access; ordinary resource caching must not bypass revocation checks.

## Success definition

A standard multi-file fixture opens unchanged from Quick Apps with no active conversation; ordinary module imports and data fetches work; a phone-reachable fixture saves to the intended Host only after grant approval; stale writes and cross-app/workspace requests fail. The membership page is a compatibility fixture, not the only supported application. Passing the legacy connector tests alone does not satisfy this Spec.
