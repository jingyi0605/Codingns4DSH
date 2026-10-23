# Magpie Web Automatic Hosting and API Verification

Date: 2026-10-23

## Conclusion

Magpie `0.1.1322` exposes structured Web API reads and writes sufficient for the Spec018.1 usage and management panels. The DSH Host now owns the Magpie Web child: enabling `modules.magpieManagement` starts it automatically on an ephemeral loopback port with browser opening disabled; disabling the feature or stopping the Host terminates only that owned child. A valid Host `MAGPIE_WEB_KEY` is reused when configured; otherwise the Host generates a cryptographically random process-local key and passes it directly to the child. No separate Web listener or manual key setup is required.

The usage and management panels use authenticated Magpie Web API routes end to end. The UI receives bounded normalized records, not Magpie's raw configuration or credentials. Provider/group/account writes remain deliberately allowlisted; the existence of broader Web API fields does not make it safe to expose every field.

## Real-device method and isolation

- Installed Magpie version: `magpie 0.1.1322`.
- The opt-in integration test uses temporary `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` directories, disables account discovery, clears proxy variables, and removes the Web key from the test environment.
- It seeds two synthetic providers with loopback-only, non-listening endpoints and two synthetic routing groups in that temporary profile. It enables the Host feature, exercises the Host RPCs through the real authenticated Magpie Web process, and verifies write read-back and isolation.
- The test reads provider/group snapshots, usage, request pages, quotas, quota history, and login usage. It edits a synthetic provider and routing group, toggles the synthetic provider off and on, and verifies the other provider/group remain unchanged.
- The test shuts down the Host feature and verifies the owned Web service is disposed. The temporary profile is removed afterward.
- No active Magpie configuration was written; no live model endpoint, DSH server, Stage0, Desktop process/profile, or GUI was operated.
- The isolated profile deliberately has no signed-in accounts or usage ledger entries. Therefore the real-device run verifies that account/usage APIs are reachable and return valid empty responses, not a real OAuth account mutation. Account `on`/`off` request semantics, cookie authentication, final-account protection, and read-back are covered by service tests against a controlled API fixture and the Magpie handler contract.

### Regression-test isolation caveat

An initial broad test run exposed a stale Pi usage fixture that constructed `MagpieUsageService` without injecting the Host-owned Web API. That test briefly started Magpie Web with the ambient environment and made read-only local `GET` requests for startup/provider, usage, and quota data before failing; it issued no writes or account changes. The child owned by that test worker was stopped. The fixture now injects a fake Web API, and both usage and management services fail closed instead of constructing a process when no Host-owned API is injected. All live write/read-back verification described above used the temporary isolated profile.

## Observed Web API fields

The following raw key names were observed by reading key names only from the isolated `0.1.1322` Web process. No response values or credentials were recorded.

### Providers: `GET /api/providers`

The root contained `providers`, `presets`, `excluded`, `gateway`, `plugins`, `movable`, and `movesTo`. A synthetic provider record contained:

`id`, `name`, `icon`, `preset`, `host`, `chat`, `responses`, `anthropic`, `catalog`, `website`, `keysUrl`, `searches`, `pinUpstream`, `unredacted`, `insecureTLS`, `takesInsecureTLS`, `nativeCompaction`, `passUserAgent`, `authHeader`, `proxy`, `balanceToken`, `testsAs`, `marksKinds`, `key`, `ready`, `chosen`, `speaks`, `fallback`, `routing`, `affinity`, `maxConcurrency`, `models`, `exposed`, `unlisted`, `noModels`, `groups`, `off`, `agents`, `sponsored`, and `keyList`.

A model record contained `id`, `name`, `efforts`, `given`, `images`, `on`, and `merge`. The raw provider response includes credential-bearing fields such as `key`, `keyList`, `balanceToken`, and `authHeader`; these are never returned to the Client or included in edit payloads. The normalized panel contract returns safe identity/status/endpoint/model and selected routing metadata, a masked key indicator only, and only edits provider name, an existing plain endpoint, exposed models, and on/off state.

### Routing groups: `GET /api/groups`

The root contained `groups`, `models`, `pools`, `deciders`, `found`, and `templates`. A group record contained `id`, `name`, `members`, `routing`, `affinity`, `ready`, `memberInfo`, `holds`, `offers`, `shared`, `patterns`, and `ref`. A `memberInfo` record contained `id`, `ready`, `provider`, `name`, `model`, `on`, `of`, and `imagesUnknown`.

The panel normalizes and returns safe member, pattern, usage-owner, routing, and stickiness fields. Writes are restricted to `name`, ordered `members`/patterns, `routing`, and `affinity` (shown as stickiness); successful writes must pass a fresh Web API snapshot and an isolation check for all other groups and providers.

### Usage: `GET /api/usage?period=...`

The zero-traffic response root contained `period`, `since`, `calls`, `errors`, `input`, `output`, `cache_read`, `cache_write`, `reasoning`, `cost`, `unpriced`, `bucket`, `series`, `providerKeys`, `sessions`, `sessionCount`, `agents`, `models`, `accounts`, `callerKeys`, and `path`. The observed `series` entries contained `label`, `time`, `calls`, `errors`, `input`, `output`, `cache_read`, `cache_write`, `reasoning`, `cost`, and `unpriced`. Group/session arrays were empty in this isolated test.

The Host accepts optional metric fields when present, including `retried`, `credits`, `credited`, `timed`, `ttft_ms`, `decode_ms`, `decode_out`, and `decode_n`, and returns `null` for absent metrics rather than inventing values. Period aliases sent to Magpie are `today`, `7d`, `30d`, and `all`.

### Requests: `GET /api/usage/requests`

The zero-traffic response root contained `callerKeys`, `period`, `rows`, `offset`, `total`, `bucket`, `series`, `by`, `calls`, `errors`, `input`, `output`, `cache_read`, `cache_write`, `reasoning`, `cost`, `unpriced`, `through`, `direct`, `reported`, `agents`, `providers`, `purposes`, and `accounts`. No request rows were present in this isolated profile, so row-level fields were not claimed from this run. The Host exact-matches `session` or `native_session` for session-filtered requests and strips error text, response IDs, endpoint URLs, prompts/replies, and unknown fields.

### Quotas and login usage

- `GET /api/usage/quotas` returned an empty array because the isolated profile had no account providers.
- `GET /api/usage/quotas/history?days=30` returned an empty array for the same reason.
- `GET /api/login/usage` returned an empty object because account discovery was disabled.
- Magpie's provider Web view can also contain `providers[].account.logins`. The Host now merges those login identity/status fields with `/api/login/usage` and quota rows, preserving `active`, `on`, allowance windows, plan, and safe labels without returning token fields. A parser test covers conflicting-source merge and credential redaction.

## Verified Web routes

| Purpose | Route | Result in verification |
| --- | --- | --- |
| Provider inventory | `GET /api/providers` | Structured provider records read successfully |
| Group inventory | `GET /api/groups` | Structured group/member/pattern records read successfully |
| Usage overview | `GET /api/usage?period=today` | Valid zero-usage snapshot parsed as available |
| Request ledger | `GET /api/usage/requests?period=today&offset=0&limit=10` | Valid empty page with total `0` |
| Quota cards/history | `GET /api/usage/quotas`, `GET /api/usage/quotas/history?days=30` | Both valid empty arrays |
| Login usage | `GET /api/login/usage` | Valid empty object; account actions remain disabled without account rows |
| Provider edit/state | `POST /api/provider/save`, `POST /api/provider/off`, `POST /api/provider/on` | Synthetic edit, off/on, and Web API read-back passed |
| Group edit | `POST /api/groups/save` | Synthetic name/model/pattern/routing/stickiness edit and read-back passed; unrelated group/provider unchanged |
| Account routing eligibility | `POST /api/login/on|off` | Mock transport covers auth, both actions, read-back, and last-account protection; no signed-in test account existed for a live mutation |

## Capability and limits

The Web API is materially more structured and complete for this UI than the CLI text readers: it returns provider and group records as objects, request/session analytics, quota/history data, and account data from multiple endpoints. It does not mean every raw setting should be exposed. Credential fields are excluded; the Client cannot send arbitrary paths or payload keys; mutations only touch existing providers/groups and a verified safe-field allowlist.

The account `on`/`off` Web routes are Magpie's internal UI API rather than a separately published stability contract. The Host re-reads the relevant Web API snapshot after a write and reports failure if the requested state or unrelated-state invariants do not match. Re-audit these routes on Magpie upgrades.

Model-catalog discovery for the Agent model picker remains a separate Magpie CLI integration; it is not used by the usage or management panel. The analytics/management panel itself no longer depends on CLI reads or CLI writes.

## Source references

- [Magpie v0.1.1322 provider and account handlers](https://github.com/yetone/magpie/blob/v0.1.1322/internal/gui/providers.go)
- [Magpie v0.1.1322 Web authentication](https://github.com/yetone/magpie/blob/v0.1.1322/internal/gui/web.go)
- [Magpie v0.1.1322 usage handlers](https://github.com/yetone/magpie/blob/v0.1.1322/internal/gui/usage.go)
- [Magpie v0.1.1322 account routing semantics](https://github.com/yetone/magpie/blob/v0.1.1322/internal/provider/logins_on.go)
