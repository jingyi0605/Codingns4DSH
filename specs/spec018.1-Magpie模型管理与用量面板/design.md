# Design: Magpie Management and Usage Panel

Status: Implemented for the native sidebar entry, usage dashboard, Web-API-backed provider/account/group management, and automatic Host-owned Magpie Web startup.

## 1. Overview

### 1.1 Goal

- Register an opt-in `magpieManagement` client feature toggle below External Agent settings.
- When enabled, contribute a native `sidebar.panellist` row directly below Plugins and a matching keyed `main` page.
- Open the management page inside DSH's main panel; do not use a modal or fixed overlay.
- Reuse Magpie Web's structured local usage, quota, provider, account, and routing-group APIs.
- Keep the Host as the only owner of Gateway discovery, query bounds, session matching, field sanitization, mutation allowlists, and write verification.

### 1.2 Requirements

- `requirements.md` R1-R6.

### 1.3 Constraints

- No Desktop operations or server starts. Magpie write tests use an isolated temporary HOME/XDG configuration; never write active user configuration.
- Model-picker catalog enrichment remains on its separate, validated `magpie models dsh`/loopback `/v1` path; the usage and management panel does not use that CLI/Gateway path.
- Numeric Magpie `cost` has no currency field in the live API schema. Keep it unlabelled by currency.
- When `modules.magpieManagement` is enabled, the Host starts its own `magpie web` child on an ephemeral loopback port with `--no-open`, authenticates using a valid configured `MAGPIE_WEB_KEY` or a generated process-local key, and stops only the child it owns.
- Never send the Web key over DSH RPC. All panel reads and writes use fixed authenticated Magpie Web API routes.
- Existing Spec018's session subscription/route path remains unchanged.

## 2. Architecture

### 2.1 Data flow

1. The feature toggle stores enablement in `modules.magpieManagement`.
2. The feature registers its sidebar row and keyed `main` page only while enabled, through DSH's public slot injection boundary; both seats must be present before either registration is published.
3. The page calls the dedicated `magpie` RPC namespace for dashboard and request pages.
4. The Host owns one `MagpieWebService` for the feature lifecycle; it discovers the ephemeral port from the child startup line, authenticates with Magpie's key-to-cookie handshake, and retries startup on later API requests after a startup failure.
5. `MagpieUsageService` reads dashboard, request, quota, and quota-history data from fixed `/api/usage...` routes. Session requests are still exact-matched by the Host. Model-catalog enrichment remains a separate CLI path outside this panel.
6. `MagpieManagementService` reads structured provider/group data from `/api/providers` and `/api/groups`, and account identity/status/quota data from `/api/providers[].account.logins`, `/api/login/usage`, and `/api/usage/quotas`.
7. Provider/group/account mutations use fixed Web API routes, strict allowlists, fresh Web API read-back, and isolation checks. Account routing eligibility uses `POST /api/login/on|off` and may reseat Agents or refresh model catalogs.
7. Every mutation is serialized, requires the Client's explicit review action, and returns success only after a fresh snapshot matches the requested fields.
8. The Client renders only normalized contracts; it cannot provide a raw command, credential, endpoint query, or configuration file.

### 2.2 Page sections

| Section | Source | Main content |
| --- | --- | --- |
| Overview | `/api/usage?period=...` | KPIs, time series, Agent/provider/model/account breakdowns |
| Sessions | `usage.sessions` | Session totals and selected-session navigation |
| Requests | `/api/usage/requests` | Paged requests with provider/account/model/cost/timing |
| Quotas | `/api/usage/quotas`, `/api/usage/quotas/history` | Current windows, daily usage, historical remaining values |
| Providers and accounts | `/api/providers`, `/api/login/usage`, `/api/usage/quotas` | Provider editor with matching accounts nested underneath; active sign-in marked primary, other saved logins secondary, status/quota, and guarded routing eligibility toggle |
| Unlinked accounts | `/api/providers[].account.logins`, `/api/login/usage`, `/api/usage/quotas` | Accounts whose Agent does not exactly match a provider ID remain visible without guessed parentage |
| Routing groups | `/api/groups` | Existing structured group inventory and verified editable fields |

### 2.3 Dedicated RPC

The CLI Host feature registers the `magpie` namespace:

- `magpie/usage/dashboard`: accepts `period`; returns one normalized dashboard snapshot.
- `magpie/usage/requests`: accepts `period`, `offset`, `limit`, and optional `sessionId`; returns one bounded page.
- `magpie/management/snapshot`: returns normalized provider, account, and group data.
- `magpie/management/provider/update`: allowlisted provider edits and provider on/off status.
- `magpie/management/group/update`: allowlisted group edits.
- `magpie/management/account/update`: account `on`/`off` through authenticated Magpie Web, followed by Web API read-back.

The Host checks `modules.magpieManagement` for every call. Fixed endpoint paths and enum-validated query parameters are built on the Host. Mutation payloads accept only bounded IDs, plain HTTP(S) URLs, provider-local model IDs, group models/patterns, and known policy enums. Account mutation requires the Host-managed authenticated Web process, rejects redirects, does not forward the key over RPC, and blocks disabling the last account in rotation.

## 3. Data contracts

### 3.1 Dashboard metrics

`MagpieUsageMetrics` contains nullable numeric fields for `calls`, `errors`, `retried`, `input`, `output`, `cache_read`, `cache_write`, `reasoning`, `cost`, `unpriced`, `credits`, `credited`, `timed`, `ttft_ms`, `decode_ms`, `decode_n`, and `decode_out`. `null` means absent or invalid, never zero.

Dashboard groups retain safe `id`, label/name, provider, model, account, Agent, and session identity fields as applicable, alongside normalized metrics. Time-series entries retain `time` and `label` plus normalized metrics. A separate `costCurrency` is not added because Magpie did not return one.

### 3.2 Request rows

Request rows may contain `route_id`, `t`, `agent`, `provider`, `providerAccount`, `model`, `req`, `served`, `in`, `out`, `cache_read`, `cache_write`, `reasoning`, `ms`, `ttft_ms`, `first_text_ms`, `first_reasoning_ms`, `flow_ms`, `status`, `cost`, `credits`, `priced`, and verified session identity. The Host omits `err`, raw request/reply content, response IDs, endpoint URLs, raw retry payloads, and unknown fields.

When a `sessionId` is provided, Magpie's `q` search is only a candidate lookup. The Host returns a row only if its `session` or `native_session` field exactly matches the requested ID. The response uses a bounded `limit` and `offset` and never returns Magpie's raw response.

### 3.3 Quota records

Quota cards normalize provider/name/kind/user/plan/alias/balance/readAt, quota windows, and daily day/used points. Quota-history records normalize provider/user, line names, and points (`at`, `left`, `start`, `resetsAt`). Limits apply to rows, windows, lines, and points.

## 4. State and refresh lifecycle

- The settings card owns the installation requirement state and passes it to its panel; manual rechecks update the same state that gates the switch. Checking, missing, and unavailable results block enabling, not disabling.
- A successful custom-path probe becomes the Host feature's selected detector and Web startup command until that feature is disposed. Failed custom probes leave that selection intact; late probe results cannot replace a newer selection or restart a disposed feature. The existing owner-only detection RPC remains the boundary for executable-path input.
- The registered settings RPC validates enablement through that same detection endpoint with a forced version check, rather than constructing an unrelated automatic detector. No manual path is written to persistent settings or Magpie configuration.
- Page load and period changes create a new AbortController and request sequence.
- Closing the page, selecting a new period, or choosing another session aborts the previous request.
- Dashboard and request reads use independent pending/error states.
- Provider/group/account edits display a review summary before the Client sends the mutation; the Host serializes writes and returns only a verified fresh snapshot. Account confirmation warns that Magpie may reseat affected Agents and refresh their model catalog.
- Provider/account/group details refresh on page reload; no cached draft is written to local storage.
- Cache state is local to the mounted page; no persistent usage ledger is written by CodingNS.
- The native sidebar registration and keyed page are both owned by the feature resource scope; disabling the feature removes both, while the page's return action selects the native conversation panel through `layout.selectPanel(null)`.

## 5. Feasibility boundary

- Providers and routing groups: Magpie `0.1.1322` returns structured Web API objects from `/api/providers` and `/api/groups`; real isolated reads and provider/group Web API writes passed read-back and mutation-isolation checks. Provider writes are restricted to name, existing plain endpoints, exposed models, and on/off. Group writes are restricted to name, ordered members/patterns, routing, and affinity/stickiness.
- Accounts: the Host merges safe identity, `active`, and `on` fields from nested provider `account.logins`, `/api/login/usage`, and `/api/usage/quotas`. The authenticated `POST /api/login/on|off` handler accepts `{Agent, User}`, calls `provider.SetLoginOn`, and wraps the change in `agent.Reseat`/`agent.SyncCatalog`; it can move affected Agents and alter their model catalog. Fresh Web API read-back verifies changes. Disabling the last account in rotation is rejected by the Host before posting. Account switching, global discovery, and `switch-only codex` remain distinct operations.
- Usage: the authenticated `/api/usage`, `/api/usage/requests`, `/api/usage/quotas`, and `/api/usage/quotas/history` routes support the analytics page. Current real-device shapes are recorded in `docs/20261023-MagpieWeb自动托管与全接口验证.md`.

## 6. Error handling

- Magpie Web startup/authentication failure: return section-level unavailable states without exposing the key or raw process output; subsequent calls retry startup.
- Non-2xx, oversized, malformed, cancelled, or timed-out Gateway response: mark only that section unavailable.
- Invalid metric: normalize to `null`.
- Session search mismatch: omit the row, regardless of Magpie's free-text result count.

## 7. Test strategy

- Parser tests: metrics, chart points, providers, accounts, groups, requests, quota cards, and history bounds.
- Host tests: fixed loopback endpoint, enablement gate, request cancellation, page bounds, exact session matching, raw-field redaction, allowlisted writes, read-back verification, and mutation isolation.
- Client tests: opt-in button/page state, provider/group editors, provider on/off review, primary/secondary account nesting and account routing review, period navigation, sessions-to-requests flow, unavailable states, and responsive-safe render structure.
- Run focused tests, typecheck, i18n check, version check, capability check, and `git diff --check`; do not start servers.

## 8. Risks and follow-up

- Magpie Web provider/group/account routes are internal UI APIs, not a published stable API contract. Re-audit response and mutation routes when upgrading; strict parsing/allowlists and read-back make mismatches fail closed.
- Cost has no currency field in the live response.
- Account routing controls require the Host-managed authenticated Magpie Web process and can reseat Agents. The isolated live profile had no accounts, so real account writes are covered by controlled API tests rather than an OAuth account mutation.
- Provider credential editing and group fields without dependable read-back remain unavailable.
