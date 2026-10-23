# Spec018.1: Magpie Management and Usage Panel

Status: Native sidebar entry, usage dashboard, provider editor/on/off, provider-nested primary/secondary accounts, authenticated Web API account routing controls, routing-group editor, and automatic Host-owned Magpie Web startup implemented.

Spec018.1 adds an opt-in Magpie Management page to DSH's global sidebar, directly below the native Plugins row. Enabling it remains a CodingNS settings toggle; the Host automatically starts its own authenticated Magpie Web child on loopback, and selecting the sidebar row opens a flat native main-panel page rather than a popup. The page uses Magpie Web API for usage, requests, quota/history, providers, accounts, and routing groups. It nests each matching Agent's accounts under its provider: the signed-in account is primary and other saved accounts are secondary. Existing providers can be edited through a narrow allowlist and switched on/off; routing groups can update name, ordered models/patterns, routing policy, and stickiness. Per-account routing eligibility can be changed through the authenticated Web API; each change requires review and may reseat affected Agents. If no valid `MAGPIE_WEB_KEY` is configured, the Host creates a random process-local key and passes it to its owned Web child.

## Documents

- [Requirements](requirements.md)
- [Design](design.md)
- [Tasks](tasks.md)
- [Initial CLI/Gateway feasibility report (historical baseline)](docs/20261022-Magpie管理与完整用量可行性调查.md)
- [Magpie Web automatic hosting and API verification](docs/20261023-MagpieWeb自动托管与全接口验证.md)

## Decision

- The installed Magpie 0.1.1322 Web API supports the structured usage, request ledger, quota/history, provider, and group reads used by the panel; real isolated startup/read/write/read-back tests passed.
- Provider and group management use Magpie Web API writes, not CLI writes. The UI exposes only safe existing-provider name/plain-endpoint/model/on-off fields and group name/ordered members-patterns/routing/stickiness; credential-bearing or unverified fields remain excluded.
- Provider/group Web responses are structured objects rather than human-readable CLI output. Strict parsing, allowlisted payloads, fresh read-back, and provider/group isolation checks guard against upstream changes and write side effects.
- Account rows merge safe fields from nested `providers[].account.logins`, `/api/login/usage`, and quota data. The authenticated `POST /api/login/{on|off}` path is verified by source audit and controlled protocol/read-back tests. The isolated live profile had no signed-in account, so no real account mutation was made.
- The active sign-in is shown as the primary account and other saved logins as secondary accounts; only accounts whose `agent` matches an existing provider ID are nested there. Unmatched accounts remain visible in a separate unlinked section rather than being guessed into a provider.
- Magpie's account API may reseat affected Agents and refresh the model catalog. The UI requires explicit review and blocks disabling the last account in rotation.
- Provider creation/removal, credential edits, account sign-in changes, and fields that cannot be verified after saving remain out of scope.
- Writes require explicit review in the UI, strict Host-side field allowlists, serialization, and post-write Web API read-back. The live integration test used temporary XDG/HOME configuration only; active Magpie configuration and DSH Desktop were untouched.

## Scope

- Add an opt-in `magpieManagement` feature toggle; when enabled, register a native global-sidebar row and matching `main` page below the Plugins row.
- Display aggregate usage by period, chart-ready time series, provider/model/account breakdowns, session totals, and exact-session request details.
- Session details are selected from Magpie's session list; the plugin-settings panel is not automatically bound to the conversation currently open in DSH.
- Display quota cards, daily usage, and historical quota windows where Magpie returns them.
- Keep request and quota reads on the owning Host; only normalized, bounded fields cross the RPC boundary.
- Edit existing provider names, plain endpoints, and exposed models; switch providers on/off.
- Edit routing-group names, ordered models/patterns, routing policy, and stickiness; never create/remove providers or groups.
- Nest matching account status/quota under providers and allow per-account routing `on`/`off` only when the Host-managed authenticated Magpie Web API is available; do not switch Agent sign-ins.
- Automatically start and stop only the Magpie Web child owned by the Host when this feature is enabled or disabled.
- Keep Agent model-picker catalog enrichment on the separate CLI path; it is outside this usage/management panel.
- Do not touch DSH Desktop.
