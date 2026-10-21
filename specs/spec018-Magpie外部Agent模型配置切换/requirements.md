# Requirements: Read-only Magpie metadata, usage, and route integration

Status: The existing scope is read-only. This amendment adds Magpie model metadata for mapped external Agents other than Codex, and uses Magpie's exact model metadata to correct the Codex context window for `auto/gpt-6.1-sol`. Model selection remains entirely in the Agent's ordinary catalog; CodingNS does not switch or persist Magpie model configuration.

## Summary

Magpie already exposes configured provider/model choices through each Agent. CodingNS does not need a CC-Switch-like configuration writer. It reads the complete mapped Agent catalog, including account-backed entries, and the standard read-only `/v1/models` response on the owning Host, then safely enriches matching model records with Magpie's metadata. For Codex, that same source corrects the context window before usage is stabilized. Usage and route data remain read-only and sanitized.

## Terms

- **Agent adapter**: A CodingNS integration such as Claude Code, Codex, or DSH.
- **Magpie Agent**: The exact Agent ID used by `magpie models <agent>`.
- **Magpie model**: A model ID that appears in the mapped Magpie Agent catalog.
- **Agent session ID**: The external Provider session identifier stored by the Host. It is not the DSH session ID.

## Scope

### In scope

- Read the bounded Magpie CLI version and model catalog on the Host that owns the selected Agent.
- Keep an explicit adapter-to-Magpie-Agent mapping, including naming differences such as `cursor-cli` -> `cursor` and `command-code` -> `commandcode`.
- Recognize a Magpie model only when its exact ID appears in the mapped Agent catalog, or when its display label maps uniquely to one catalog ID. Command Code may use its documented `magpie/provider/model` normalization.
- Read aggregate Magpie usage through the documented local Gateway API.
- Read model metadata through the Gateway's standard OpenAI-compatible `/v1/models` endpoint and expose it to external Agent catalogs using exact verified model IDs.
- Correct Codex context sizing from Magpie metadata for the exact Magpie model in use.
- Read the current Agent session usage and route only when the Host has a distinct Provider session ID and Magpie confirms the exact Agent/session pair.
- Display Magpie aggregate, session, and route information separately in the existing usage section.
- Preserve the ordinary provider subscription path when the model is not in Magpie's catalog or Magpie reads fail.

### Out of scope

- A separate Magpie model group, model selector, confirmation page, or model-source marker in the Client.
- Any Magpie configuration write, model switching, read-back, restore, profile switching, or CC-Switch-like behavior.
- `magpie <agent> <model>` and `magpie <agent> model` invocations from CodingNS.
- Persisting Magpie provenance in a DSH session or accepting Client-supplied provenance hints.
- Installing, updating, starting, or opening Magpie; importing provider files or credentials; signing in; or managing API keys.
- Calling undocumented Magpie-specific HTTP endpoints, writing Agent/Magpie configuration files, or operating DSH Desktop. The only model metadata endpoint is the read-only OpenAI-compatible `/v1/models` endpoint.
- Claiming that a model is Magpie-provided from a slash, provider name, display label, or adapter name alone.

## Requirements

### R1: Optional, exact catalog recognition

**User story:** As a user, I want ordinary Agent model selection to keep working whether Magpie is installed, configured, or available.

#### Acceptance criteria

1. The Host uses an explicit adapter-to-Magpie-Agent allowlist and invokes only the bounded read-only catalog command.
2. The current model is recognized as Magpie only after exact ID membership, or a unique exact normalized display-label match, in the mapped Agent catalog. Unsupported mappings, missing Magpie, old versions, malformed output, empty catalogs, and unavailable Gateway origins fail closed.
3. All current mappings are read-only catalog mappings; a mapping does not imply that CodingNS can write or switch the Agent configuration.
4. Magpie discovery and usage reads happen on the Host that owns the adapter. A remote Host's Magpie installation is never inferred from or replaced by the local machine's installation.
5. The DSH native adapter follows the same read-only path as external adapters when its model is present in the `dsh` catalog.

### R2: Host-only usage and route reads

**User story:** As a user, I want to see Magpie's usage and the route for the current Agent session without exposing sensitive data.

#### Acceptance criteria

1. For an exact catalog match, the Host reads only the documented `/v1/magpie/usage` endpoint and, when requested, `/v1/magpie/route?session=<id>`.
2. The Gateway origin is accepted only as a local loopback HTTP origin discovered from the catalog output. Requests use bounded response size, timeout, cancellation, and sanitized fields.
3. Aggregate usage, current-session usage, and route data remain separate. Aggregate totals are never presented as current-session totals.
4. A route lookup uses only the Host's distinct Provider session ID. If it is absent, equal to the DSH session ID, not present for the exact Agent, or not echoed by the route response, the route is unavailable.
5. The Host never sends or returns prompts, replies, credentials, raw Gateway errors, or private Agent/Magpie configuration contents.

### R3: Existing usage behavior remains intact

**User story:** As a user, I want a Magpie read failure or ordinary model to preserve the existing subscription display.

#### Acceptance criteria

1. A non-Magpie model returns the existing provider subscription result without a Magpie Gateway request.
2. A failed catalog or Gateway read does not disable the Agent, change its selected model, or hide ordinary provider usage.
3. The Client may cache snapshots using the existing serial refresh lifecycle, but cache keys include the Agent, model, DSH session, and Provider session identity.
4. Route reads are requested only while the Magpie usage panel is open and are cancelled when the panel or session closes.

### R4: Read-only safety boundary

**User story:** As a user, I want this integration to be unable to alter Agent configuration or accounts.

#### Acceptance criteria

1. Every Magpie CLI invocation is read-only and bounded. Model catalog reads must not set or inherit `MAGPIE_NO_ACCOUNTS`, because that flag hides valid account-backed model entries; CodingNS still never writes Magpie configuration or accounts.
2. The Client has no Magpie model-switch RPC, setter, read-back, restore workflow, or persisted provenance field.
3. CodingNS never starts Magpie's desktop UI, gateway, or web server, and never touches DSH Desktop.
4. Model selection continues to use the Agent's normal model catalog and existing `session/set` path.

### R5: Verification and compatibility

**User story:** As a maintainer, I want the read-only boundary and fallback behavior to be evidenced by focused tests.

#### Acceptance criteria

1. Parser tests cover the captured catalog shape, exact Agent footers, malformed/oversized output, duplicate and loopback-origin rejection, and the version gate.
2. Mapping tests cover DSH, all currently registered external adapter IDs, and naming differences such as Cursor and Command Code.
3. Usage tests cover aggregate/session separation, exact Agent/session matching, route echo validation, cancellation, bounds, and credential redaction.
4. Host RPC tests prove that subscription reads try Magpie for the current session and fall back to ordinary usage when `read()` returns `null`.
5. Tests do not write real Agent configuration, query real account data, make model inference requests, start a Gateway, or operate Desktop.

### R6: Expose Magpie model metadata to mapped external Agents other than Codex

**User story:** As a user, I want every supported external Agent other than Codex to expose correct Magpie-provided model context, thinking intensities, and other public model metadata.

#### Acceptance criteria

1. The Host fetches Magpie `/v1/models` only after the mapped `magpie models <agent>` catalog and its loopback Gateway origin have been validated.
2. A record is eligible only when its exact model ID appears in that same mapped Agent's CLI catalog, or when the Agent row has a unique exact normalized display-label alias to one CLI ID. Only explicitly tested adapter-specific normalization (currently Command Code's `magpie/` prefix) is allowed; there is no fuzzy matching.
3. For exact matches, expose Magpie's model display label, context window, maximum input/output tokens, input/output modalities, reasoning support and levels, service tiers, and other supported public capabilities through the shared model contract.
4. `reasoning_levels` and `supported_reasoning_levels` are normalized into the Agent model's existing effort identifiers. The Host never invents effort levels from a model name or a bare reasoning boolean.
5. Magpie-provided metadata takes precedence for a field it explicitly declares on an exact Magpie model. If a field is absent, preserve the Agent's existing verified value; explicit `reasoning: false` clears stale effort options.
6. A missing, malformed, oversized, timed-out, or unavailable `/v1/models` response leaves the Agent's ordinary model catalog usable and unchanged. No raw Magpie response or credential crosses the Host boundary.
7. Metadata is read-only and Host-owned; the Client cannot supply or override model metadata. The metadata read does not create new selection RPCs or persist a Magpie model choice.
8. Tests cover every verified external adapter-to-Magpie mapping except Codex, exact ID matching, field normalization, missing/invalid fields, fallback behavior, and no account/configuration writes.

### R7: Correct Magpie-backed Codex context before stabilization

**User story:** As a user of `auto/gpt-6.1-sol` through Codex, I want usage and compaction thresholds to use the 500,000-token context window Magpie advertises rather than 258,400.

#### Acceptance criteria

1. For the exact Codex model ID `auto/gpt-6.1-sol`, the Host reads `context_window`/`context_length` from the validated Magpie `/v1/models` record and applies it before `stabilizeCodexUsage` anchors the first context window.
2. A stale `258400` event value cannot overwrite the validated `500000` Magpie value, and `contextUsageRatio` is recomputed with the corrected denominator.
3. The correction occurs before the usage event is projected to DSH and before Codex compaction thresholds are evaluated.
4. Model IDs are exact: `auto/gpt-6.1-sol`, `codex/gpt-6.1-sol`, and `glorinfo-api-platform/gpt-6.1-sol` are distinct records. Metadata for one is never applied to another.
5. If Magpie metadata cannot be read, the known Codex fallback for `gpt-6.1-sol` is 500,000. Other Codex model fallbacks and ordinary providers retain their existing behavior.
6. Tests cover the `258400` to `500000` conflict, first-window anchoring, later usage events, ratio calculation, and exact model-ID isolation.

### R8: Preserve the read-only and ordinary Agent boundary

1. The model selector remains each Agent's normal catalog and session-only selection path. No Magpie switching UI, setter, read-back, restore, or provenance is reintroduced.
2. Unsupported or ordinary Agent models keep their existing effort, catalog, turn, subscription, and session behavior.
3. A remote Agent's model metadata is read only on its owning Host; local Magpie is never used as a remote fallback.

## Success definition

- The ordinary Agent model selector remains the only model-selection UI and path.
- DSH and mapped external adapters can be recognized as Magpie-backed only through exact catalog membership.
- Mapped external Agent catalogs expose Magpie's verified model metadata, and Codex reports the exact 500,000-token window for `auto/gpt-6.1-sol` before usage stabilization.
- The usage section displays sanitized Magpie aggregate/session/route data when available and preserves ordinary provider usage otherwise.
- No current source or RPC path can switch or persist a Magpie model configuration.
