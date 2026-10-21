# Design: Read-only Magpie metadata, usage, and route integration

Status: Usage/catalog recognition is implemented. This amendment adds bounded model metadata reads and a Codex context correction; the old selector, setter, read-back, and provenance design remains historical and out of scope.

## 1. Design decision

Magpie already integrates configured provider/model choices into each Agent's model catalog. CodingNS does not create a second model-selection source in the Client and does not write Agent configuration. For a model already present in the Agent's normal catalog, the Host may enrich its metadata only after exact identity is confirmed by `magpie models <agent>` and Magpie's `/v1/models` record.

CodingNS also uses the verified Magpie record to supply context-window and related metadata. The exact Codex Magpie model `auto/gpt-6.1-sol` must use Magpie's 500,000-token context window before usage anchoring and compaction. A missing or invalid record never disables the normal catalog or usage path.

## 2. Data flow

```text
Current DSH session
  -> Host reads adapter, model, providerSessionId
  -> Host resolves the explicit adapter -> Magpie Agent mapping
  -> Host runs bounded `magpie --version` and `magpie models <agent>`
  -> Host requires exact catalog membership and a loopback Gateway origin
  -> Host optionally reads bounded `/v1/models` and validates the exact model record
  -> Host merges safe model metadata into the Agent's existing model catalog
  -> Host reads aggregate usage
  -> Host optionally reads route for the distinct Provider session ID
  -> Client displays aggregate, session, and route data separately

No separate model-selector branch, Magpie setter, or session provenance is involved. Metadata is Host-derived; Client-supplied model properties are ignored.
```

The DSH session ID is never substituted for an Agent session ID. The Host only uses a `providerSessionId` that differs from the DSH session ID, and route data is requested only after the usage payload contains the exact Agent/session pair.

## 3. Host boundary

### 3.1 Explicit mapping

The mapping lives in `src/host/cli-adapters/magpie-usage.ts` and is not derived from names:

| CodingNS adapter | Magpie Agent |
| --- | --- |
| `dsh` | `dsh` |
| `claude-code` | `claude` |
| `codex` | `codex` |
| `command-code` | `commandcode` |
| `kimi` | `kimi` |
| `gemini` | `gemini` |
| `pi` | `pi` |
| `opencode` | `opencode` |
| `grok` | `grok` |
| `mcode` | `minimax-code` |
| `zcode` | `zcode` |
| `codebuddy` | `codebuddy` |
| `workbuddy` | `workbuddy` |
| `cursor-cli` | `cursor` |
| `qoder` | `qoder` |
| `qoder-cn` | `qoder-cn` |
| `antigravity` | `agy` |

The map authorizes read-only catalog recognition only. It does not authorize any configuration write.

### 3.2 CLI and parser

- `magpie --version` is accepted only at or above the verified minimum version.
- `magpie models <agent>` is executed with fixed argument arrays, bounded output, a timeout, `shell: false` except the platform's required command-wrapper behavior, and `MAGPIE_NO_ACCOUNTS=1`.
- The parser requires the exact Agent footer, at least one model row, one loopback Gateway URL, and exact bounded model IDs. Unknown output fails closed.
- The parsed catalog stays Host-private. The Client receives no Magpie catalog and no raw CLI output.
- Catalog and version reads are cached briefly and share in-flight reads per Agent. A caller abort does not cancel a shared Host-lifetime read.

### 3.3 Gateway reads

`MagpieUsageService.read()` first confirms the current model in the current Agent catalog. It then reads:

- `GET /v1/magpie/usage?period=today` for aggregate totals and exact Agent/session rows.
- `GET /v1/magpie/route?session=<id>` only when the Client requests route details, the session row matched, and the session ID is bounded.

Responses are size-limited and normalized to the shared `MagpieUsageSnapshot` contract. Only safe counts, costs, route strings, attempt model IDs, and status fields cross the Host boundary.

### 3.4 Model metadata reads

- Add a bounded, read-only `GET /v1/models` reader on the Host, reusing the validated loopback origin and the existing response-size and timeout safeguards.
- Normalize only known public fields: `id`, `display_name`/`magpie_label`, `context_window`/`context_length`, `max_input_tokens`, `max_output_tokens`, `modalities.input`/`modalities.output`, `reasoning`, `reasoning_levels`, `supported_reasoning_levels`, `service_tiers`, and explicitly supported capability/description fields.
- Require both the exact model ID in the mapped `magpie models <agent>` output and an exact matching `/v1/models` `id`. Apply only documented adapter-specific ID normalization; Command Code's `magpie/` prefix is the existing exception.
- Enrich existing Agent model entries; do not synthesize models from unrelated records or change model-selection semantics. On exact Magpie matches, Magpie's declared value wins. An absent field preserves the Agent's own known value; explicit `reasoning: false` removes stale efforts.
- Cache parsed metadata per Magpie Agent for a short bounded TTL and clear it when its catalog/origin changes. A failed metadata read degrades to the unmodified Agent catalog.
- Never return the raw Magpie document, ownership secrets, or unrecognized fields to the Client.

### 3.5 Codex context correction

- For an exact Codex model ID confirmed by both the `codex` CLI catalog and Magpie, the Host associates the validated Magpie `context_window` with the model before Codex usage events are stabilized.
- The trusted context value is carried through a Host-owned model metadata lookup or turn input, not a Client payload. `codexUsageChunk`/the Codex event boundary applies it before `stabilizeCodexUsage`; a contradictory `258400` event cannot become the anchor for `auto/gpt-6.1-sol`.
- Recompute `contextUsageRatio` using Magpie's value. The Codex compaction threshold and DSH projection then observe the same corrected context window.
- The static fallback for `gpt-6.1-sol` is corrected to `500000` for operation when the live Magpie record is unavailable. Do not apply it to other similarly named provider-qualified model IDs.

## 4. RPC and session behavior

The Host keeps the existing `cli/models`, `cli/session/set`, and ordinary subscription RPCs. There are no `cli/magpie/models` or `cli/magpie/set-model` actions.

For `cli/subscription`:

1. Read the current Host session by `sessionId`.
2. If the session adapter matches the request, call `magpieUsage.read(session, signal, includeRoute, dshSessionId)`.
3. If the result is non-null, return `{ providerUsage: null, magpie }`.
4. If the result is null, call the existing provider subscription service and return `{ providerUsage, magpie: null }`.

The Client does not send or receive model provenance. Old persisted records may contain obsolete fields; hydration ignores them and new records do not write them.

## 5. Client behavior

The model selector renders only the normal Agent model catalog. Selecting any model uses the existing `session/set` flow and never invokes Magpie.

The existing subscription slot understands the tagged snapshot response and retains compatibility with older Hosts that return provider usage directly. It includes the session/provider identity in its cache key, requests route details only while the Magpie panel is open, and cancels the open-panel route signal on close or session change.

The Magpie usage popover labels aggregate totals, current-session totals, and route status separately. It displays unavailable states instead of attributing aggregate usage to the current session or guessing a route.

## 6. Safety and compatibility

- No Magpie configuration file, provider file, credential store, or Desktop profile is read or written.
- No Magpie setter, current-model read-back, restore operation, or persistent switching state exists in source or RPC contracts.
- Remote PeerHost routing continues to handle the ordinary `cli/*` endpoints; it has no Magpie-specific configuration path.
- Ordinary provider usage is preserved when catalog recognition or Gateway reads fail.
- Tests use fixtures and fake fetch responses only. They do not start a Gateway, execute a model turn, or operate Desktop.

## 7. Verification mapping

| Behavior | Evidence |
| --- | --- |
| Exact catalog parsing and version gate | `tests/magpie-usage.spec.ts` |
| DSH and external Agent mapping, including Cursor | `tests/magpie-usage.spec.ts` |
| Aggregate/session/route separation and redaction | `tests/magpie-usage.spec.ts` |
| Host Magpie attempt and ordinary fallback | `tests/cli-adapters.spec.ts` |
| Ordinary model selector remains the only selector | `tests/cli-slots-translation.spec.ts` |
| Remote model/session routing without Magpie-specific RPCs | `tests/peer-host-model-navigation.spec.ts` |

## 8. Metadata amendment verification

| Behavior | Evidence |
| --- | --- |
| `/v1/models` response bounds, parser, metadata normalization, and exact Magpie catalog matching | Focused tests in `tests/magpie-usage.spec.ts` or a dedicated Magpie metadata test |
| Enrichment for each verified external Agent except Codex, including effort labels/modalities/token limits | Host catalog merge tests covering all fixed adapter mappings |
| Magpie metadata failures preserve the original Agent catalog | Fake API timeout/schema/ID-mismatch tests |
| `auto/gpt-6.1-sol` corrects stale Codex `258400` before stabilization and compaction | Codex and registry tests for ratio, anchored window, and exact-ID isolation |
| Read-only live model metadata evidence | `docs/20261021-Magpie模型元数据实机读取与上下文纠正验证.md` |

Historical switching evidence remains under the Spec `docs/` directory for traceability only; it does not define the current implementation.
