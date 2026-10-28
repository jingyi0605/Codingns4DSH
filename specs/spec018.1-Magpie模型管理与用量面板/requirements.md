# Requirements: Magpie Management and Usage Panel

Status: Implemented for the Web-API-backed usage dashboard, provider editing/on-off, provider-nested primary/secondary accounts, account routing controls, routing-group editing, and automatic Host-owned Magpie Web startup.

## Summary

Add an opt-in Magpie feature toggle to CodingNS settings. When enabled, add a native “Magpie Management” row directly below DSH's Plugins row in the global sidebar; selecting it opens a flat main-panel page, not a modal. The page combines a complete usage dashboard with safe editing of existing providers and routing groups, and a provider-first account hierarchy with primary/secondary status and guarded account routing controls. A feasibility report records supported interfaces and write boundaries.

## Terms

- **Gateway**: The local Magpie HTTP Gateway discovered from a validated Magpie Agent model catalog.
- **Magpie Web**: The local authenticated Web API process owned and lifecycle-managed by the Host while this feature is enabled.
- **Usage period**: One of `today`, `week`, `month`, or `all`.
- **Request row**: A normalized entry from Magpie's request ledger. It contains routing and accounting metadata, not prompt or reply content.
- **Session**: The exact session identity returned by Magpie's usage ledger, not an inferred DSH session title.

## Scope

### In Scope

- An opt-in Client feature toggle and a native DSH global-sidebar entry with a separate dashboard page.
- Period totals and time series for calls, errors, retries, tokens, cache, timings, and Magpie-reported cost.
- Provider, model, account, Agent, and session usage breakdowns where Magpie returns them.
- Paginated request rows with requested/served model, provider/account, usage, cost, status, and timing.
- Exact-match session request detail, including a Host-side identity check after Magpie's free-text search.
- Subscription quota cards, daily usage, and quota history.
- A live feasibility report for provider, account, and routing-group configuration management.
- Editing existing providers' names, already-configured plain HTTP(S) endpoints, and exposed model lists; switching a provider on/off.
- Reading account status/quota and editing existing routing groups' names, ordered models/patterns, routing policy, and stickiness.
- Nesting accounts under matching providers, using `active` to label the signed-in primary and other saved accounts as secondary; unmatched accounts remain visible without an inferred parent.
- Changing an account's routing `on`/`off` through Magpie Web's authenticated loopback API, with an explicit review, final-in-rotation guard, and Web API read-back.
- Automatically starting Magpie Web when the feature is enabled, generating a process-local key if no valid `MAGPIE_WEB_KEY` is configured, and stopping only the Host-owned child on disable/shutdown.

### Out of Scope for This Implementation

- Creating/removing providers or routing groups, editing provider credentials or other unverified provider fields.
- Account sign-in/out or account switching; per-account routing controls when authenticated Magpie Web is unavailable; provider/account/group fields not supported by the Host-side allowlist and verified read-back.
- Any DSH Desktop or Desktop profile operation.
- Displaying prompts, replies, raw errors, credentials, raw response IDs, private endpoints, or unbounded raw Gateway JSON.
- Labeling `cost` with a currency not explicitly returned by Magpie.

## Requirements

### R1: Optional feature and entry point

**User story:** As a DSH user, I want to enable Magpie management separately and open it from the global sidebar.

#### Acceptance criteria

1. The `magpieManagement` feature is disabled by default and its enable toggle appears directly after external Agent settings.
2. When enabled, a native “Magpie Management” sidebar row appears immediately below “Plugins”; when disabled, both its row and main page are removed.
3. Selecting the row opens the dashboard as a flat main-panel page, with a return-to-conversation action and responsive desktop and narrow-screen layouts; it is not a modal or fixed overlay.
4. Disabling the feature removes its native panel registrations, and the Host rejects dashboard RPC calls while the module setting is off.
5. The settings card and installation panel share one detection result. A successful manual executable path unlocks the enable switch and is saved in the owning Host's local state for reuse by enablement validation and Web startup across Host restarts. Only the path is persisted, never the detection result; startup and enablement revalidate the executable. Failed custom probes or failed storage writes do not replace a working selection. An explicit restore-automatic-detection action clears the saved path even if automatic discovery finds nothing. An enabled module can still be disabled when detection fails. The saved path is not part of exported settings and is not synchronized to PeerHosts.

### R2: Period usage dashboard

**User story:** As a user, I want to understand Magpie gateway usage and cost over time.

#### Acceptance criteria

1. The user can select `today`, `week`, `month`, or `all`; the selection refreshes all period-sensitive totals, charts, and breakdowns.
2. The overview presents request/error/retry totals, input/output/cache/reasoning tokens, timing metrics, priced cost, and unpriced usage as distinct metrics.
3. Time-series charts use Magpie's `series` records and preserve the reported bucket labels/times; empty and partial data are represented without fabricated zeros.
4. Provider, model, and account rows retain Magpie's identifiers and totals, with unknown fields omitted rather than guessed.
5. The UI calls numeric `cost` Magpie-reported cost and does not add a currency symbol unless the API supplies a currency.

### R3: Sessions and request ledger

**User story:** As a user, I want to inspect which providers and accounts actually served a session and the corresponding request costs.

#### Acceptance criteria

1. The session list shows Magpie's session ID, Agent, request/error counts, tokens, and reported cost, plus the total session count when provided.
2. Selecting a session loads request-ledger pages and displays timestamp, Agent, requested model, selected provider/model, served model, account label, status, token/cache counts, cost/pricing status, latency, and route identity when present.
3. For session detail, the Host queries using the session ID but returns a row only when `session` or `native_session` exactly equals that ID; free-text search alone is never treated as identity proof.
4. Request list pagination has bounded `limit` and `offset`; the Client cannot increase Host response limits or request arbitrary URLs.
5. Prompt/reply text, raw error messages, raw IDs not needed for navigation, and response bodies never cross the Host boundary.

### R4: Subscription quota display

**User story:** As a user, I want to see the subscription allowance of the providers/accounts used by Magpie.

#### Acceptance criteria

1. The page displays quota cards with provider/account/plan labels and each available usage window.
2. Daily quota records and quota-history points render as charts when available.
3. Missing quota data is distinct from zero remaining; reset times and units are displayed only when returned.
4. Quota reads are independent of usage-ledger reads: one failing endpoint does not hide the other sections.

### R5: Host boundary, privacy, and failure behavior

**User story:** As a user, I want the dashboard to read only the local Magpie Gateway and avoid leaking private ledger data.

#### Acceptance criteria

1. Usage and management panel reads use fixed authenticated Magpie Web API paths; the separate model-picker catalog integration continues to discover the Gateway from a validated Magpie catalog and accepts only HTTP loopback `/v1` origins.
2. Web reads use fixed endpoint paths, GET, bounded timeouts, response-size caps, cancellation, and bounded pagination.
3. The Host normalizes known fields into internal contracts and never returns raw Gateway responses.
4. When enabled, only the Host launches its owned `magpie web` process on loopback; the dashboard never launches the Magpie Gateway, a DSH server, an Agent, or Desktop.
5. Unavailable Magpie, malformed responses, unsupported versions, timeouts, and cancellation produce explainable unavailable states without breaking ordinary subscription usage.

### R6: Management feasibility and write safety

**User story:** As a user, I want provider/account/group controls only when the installed Magpie version exposes a dependable supported mutation path.

#### Acceptance criteria

1. The Spec report records exact live read/write fields and commands, isolated test method, and unsupported write surfaces.
2. Existing providers can edit only name, existing plain endpoints, exposed models, and on/off status through Magpie Web API. Provider creation/removal and credential edits are not exposed.
3. Existing routing groups can edit only name, ordered models/patterns, routing policy, and stickiness through Magpie Web API, with allowlisted payloads, explicit confirmation, and post-write read-back verification.
4. Account hierarchy merges safe login fields from `providers[].account.logins`, `/api/login/usage`, and quota data; `active` identifies the signed-in primary and `on` is routing eligibility. Accounts attach only when `account.agent` exactly matches a provider ID.
5. Per-account routing `on`/`off` is sent only through authenticated Magpie Web `POST /api/login/{on|off}` at a loopback HTTP(S) origin; the API key stays in the Host process and is never returned over RPC.
6. Account changes require explicit review, prevent disabling the last account in rotation, and verify the saved `on` state through a fresh Web API snapshot. The UI explains that Magpie can reseat affected Agents and sync their model catalog.
7. Account sign-in switching and `switch-only codex` are not confused with an account's Magpie routing eligibility.
8. Failed or unverified writes do not report success; successful group writes are tested not to change provider or other-group state.

## Non-Functional Requirements

### Reliability

- A dashboard refresh is cancellable when the page closes or the selected period/session changes.
- Concurrent refreshes do not allow older results to overwrite newer state.
- Each section can fail independently and leaves the rest of the dashboard usable.

### Security

- No Magpie API key, provider key, OAuth credential, prompt, reply, or raw configuration data crosses RPC.
- The Client chooses only a period, bounded page offset, page size within Host limits, and an optional bounded session identity.
- Management writes accept only normalized allowlisted values, require an explicit user confirmation step in the UI, serialize mutations, and return success only after Magpie read-back matches.
- Provider keys, account credentials, request content, and raw Magpie output never cross the RPC boundary.

## Success Definition

- Enabling the feature exposes a separate dashboard page from plugin settings.
- The dashboard reports aggregate, provider/account/model, session/request, and subscription quota data from real Magpie fields.
- Session request details are identity-checked by the Host and include actual provider/account attribution and reported costs.
- Existing provider switches and safe edits plus the supported routing-group edits work through Magpie Web API and read back correctly.
- Matching accounts appear under their provider as primary/secondary entries; configured Web API controls are hidden or disabled if authentication is unavailable.
- Per-account API writes are verified by authenticated protocol tests and fresh Web API read-back; a real account write requires an isolated signed-in account fixture, not the active user's account.
