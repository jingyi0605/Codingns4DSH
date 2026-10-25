# Design - Magpie Session Context Component

Status: Complete

## 1. Overview

### 1.1 Goals

- Use Magpie's request-observed context composition for sessions routed through Magpie.
- Reuse the native composer location and interaction model while enhancing only the Magpie session's native context meter.
- Keep the existing native DSH meter as the safe fallback.

### 1.2 Covered requirements

- `requirements.md` Requirements 1-4

### 1.3 Technical constraints

- Host: TypeScript, existing `MagpieWebService`, existing `MagpieUsageService`, authenticated loopback Magpie Web API.
- Client: React, existing DSH composer presentation and slot mirror.
- Transport: CodingNS Host RPC under the existing `magpie` namespace.
- Data: in-memory bounded snapshot; no raw prompt persistence.
- Compatibility: DSH `contextPressure` and `contextBreakdown` projections remain untouched for non-Magpie sessions.

## 2. Architecture

### 2.1 System structure

1. The session composer presentation obtains the current DSH session ID.
2. A Client context store requests `magpie/context` for that session and coalesces reads.
3. The Host resolves the session's selected adapter/model/provider and rejects non-Magpie sessions before starting or using Magpie Web for this read.
4. The Host reads `/api/context?days=7`, exact-matches the session and Agent, sanitizes the selected record, and returns the CodingNS contract.
5. The Client mounts a zero-layout Magpie enhancer in the composer dock. Once valid Magpie data is ready, the composer wrapper feeds Magpie pressure into the native context meter and the enhancer redirects its native trigger to the Magpie panel; otherwise the native meter remains fully native.

### 2.2 Module responsibilities

| Module | Responsibility | Input | Output |
| --- | --- | --- | --- |
| `MagpieUsageService` | Read and sanitize `/api/context` | Agent and bounded session identities | Context session contract or `null` |
| CLI Host feature | Decide whether a DSH session is Magpie-backed and expose RPC | DSH session ID | Host RPC result |
| Shared Magpie contract | Stable bounded data model | Sanitized Host data | Client-readable snapshot |
| Context store | Coalesce, refresh, and invalidate per-session reads | RPC client and session ID | React snapshot |
| Magpie context meter | Render the screenshot-shaped trigger and panel | Context snapshot | React UI |
| Session presentation adapter | Insert meter and suppress native meter only when ready | Session ID and store state | Composer slot/presentation |

### 2.3 Key flows

#### 2.3.1 Initial session render

1. The composer dock mounts for a session.
2. The context store asks the Host for a Magpie snapshot.
3. The Host verifies the selected model/provider and returns `null` for non-Magpie sessions.
4. A non-Magpie or unavailable result leaves the native DSH meter unchanged.
5. A valid snapshot causes the wrapper to project Magpie pressure into the native ContextMeter while the hidden enhancer intercepts its trigger; the native button remains the only visible control.

#### 2.3.2 Panel refresh

1. A mounted Magpie snapshot starts a three-second-or-longer refresh loop; opening the panel keeps that content current.
2. A newer snapshot replaces the old one only if its session identity still matches.
3. Refreshes retain the last good snapshot while in flight or on transient failure, so the native button and panel do not remount or disappear.

## 3. Components and interfaces

### 3.1 Core components

- `MagpieContextSession`: sanitized Host-to-Client snapshot for one session.
- `MagpieContextStore`: per-RPC-client/session external store used by the composer wrapper and custom meter.
- `MagpieContextMeter`: trigger, anchored panel, category tabs, composition bar, and content rows.
- `createSessionPerformancePresentation`: existing composer decorator extended with an optional Magpie context source and dock entry.

### 3.2 Data structures

#### 3.2.1 `MagpieContextPart`

| Field | Type | Required | Description | Constraint |
| --- | --- | --- | --- | --- |
| `kind` | union | yes | `system`, `tools`, `memory`, `files`, `results`, or `chat` | fixed allowlist |
| `tokens` | number | yes | Total tokens for the part | safe non-negative integer |
| `items` | array | yes | Bounded named items | at most 24 |

#### 3.2.2 `MagpieContextItem`

| Field | Type | Required | Description | Constraint |
| --- | --- | --- | --- | --- |
| `name` | string | yes | Safe display name | at most 200 characters; no control characters |
| `tag` | string | no | Safe item category | at most 64 characters |
| `count` | number | no | Aggregated item count | safe non-negative integer |
| `tokens` | number | yes | Item token size | safe non-negative integer |

#### 3.2.3 `MagpieContextSession`

| Field | Type | Required | Description | Constraint |
| --- | --- | --- | --- | --- |
| `agent` | string | yes | Magpie Agent ID | allowlisted normalized ID |
| `key` | string | yes | Magpie session key | bounded identity |
| `title` | string | no | Safe session title | bounded display text |
| `model` | string | yes | Latest observed model | bounded display text |
| `requests` | number | yes | Number of matching prompt requests | safe non-negative integer |
| `turns` | number | no | Latest prompt turn count | safe non-negative integer |
| `usedTokens` | number | yes | Latest prompt token count | safe non-negative integer |
| `contextWindow` | number | yes | Latest known context capacity | positive safe integer |
| `cacheTokens` | number | yes | Matching cache-read tokens | safe non-negative integer |
| `cacheRate` | number | yes | Cache ratio | 0..1 |
| `latestId` | number | no | Latest Magpie route ID | positive safe integer |
| `parts` | array | yes | Prompt composition | fixed six-part model |
| `points` | array | yes | Bounded request points | at most 160 |

### 3.3 Interface contracts

#### 3.3.1 Magpie context RPC

- Type: CodingNS RPC
- Path: `magpie/context`
- Input: `{ sessionId: string }`
- Output: `MagpieContextSession | null`
- Validation: bounded DSH session ID; Host derives Agent and candidate identities; no client-supplied Agent or provider identity is trusted.
- Errors: invalid input or Host transport failure uses the existing RPC error channel; no matching/non-Magpie session returns `null`.

#### 3.3.2 Magpie Web API read

- Type: authenticated HTTP GET
- Path: `/api/context?days=7`
- Input: Host-owned Magpie Web cookie and bounded lookback.
- Output: Magpie's context response, reduced to one matching session.
- Validation: days is clamped to the supported range; response fields are allowlisted and bounded.
- Errors: timeout, authentication failure, invalid response, or missing session returns an unavailable result to the RPC handler.

## 4. Data and state model

### 4.1 Data relationships

- One DSH session ID maps to zero or one current Magpie context snapshot.
- One Magpie snapshot contains one selected session record and its bounded request points.
- The snapshot is not persisted and never becomes part of the DSH session history.
- The selected DSH session identity is authoritative; a search candidate or Agent-only match is insufficient.

### 4.2 State transitions

| State | Meaning | Entry | Exit |
| --- | --- | --- | --- |
| `idle` | No request made for the current session | store created | first subscription |
| `loading` | Host read in progress | subscription or refresh | `ready`, `native`, or `error` |
| `ready` | Valid Magpie snapshot | exact match and parse success | session change, confirmed native result, dispose |
| `native` | Session is non-Magpie or no matching snapshot | Host returns `null` | new session or retry |
| `error` | Read failed | transport or parse failure | bounded retry or dispose |

## 5. Error handling

### 5.1 Error types

- `MAGPIE_CONTEXT_INVALID_SESSION`: invalid Client session ID.
- `MAGPIE_CONTEXT_UNAVAILABLE`: Magpie Web unavailable, unauthorized, timed out, or returned an unsupported response.
- `MAGPIE_CONTEXT_NO_MATCH`: valid Magpie response with no exact matching session.
- `MAGPIE_CONTEXT_STALE`: response belongs to an older session or request generation.

### 5.2 Response format

The RPC uses the existing CodingNS result envelope. The success value is either a bounded `MagpieContextSession` or `null`; raw Magpie errors and prompt text never cross the boundary.

### 5.3 Handling strategy

1. Input validation errors are rejected before any Web request.
2. Non-Magpie sessions return `null` and preserve native UI.
3. Magpie Web failures use the native fallback on the initial read; later refresh failures retain the last good snapshot and use bounded retry.
4. A stale response is ignored by the Client store's generation check.

## 6. Correctness properties

### 6.1 Session isolation

For any two DSH sessions with different IDs, a snapshot returned for one session SHALL never be rendered by the other.

**Validation:** Requirement 1 and Requirement 2; Host matching tests and Client stale-response tests.

### 6.2 Native fallback preservation

For any session that is not confirmed Magpie-backed or whose Magpie snapshot is unavailable, the native ContextMeter projection values and visual entry SHALL remain available.

**Validation:** Requirement 1 and Requirement 4; composer presentation tests.

### 6.3 Bounded data

For any accepted Magpie response, all data crossing the RPC boundary SHALL satisfy the fixed field, length, count, and numeric limits in §3.2 and SHALL contain no raw prompt text.

**Validation:** Requirement 2; parser and redaction tests.

## 7. Test strategy

### 7.1 Unit tests

- Parse valid and malformed Magpie context responses.
- Match DSH/provider session identities and Agent aliases.
- Reject unknown fields, raw text, oversized arrays, invalid numbers, and mismatched sessions.
- Compute cache rate, composition totals, category filtering, and compact token formatting.

### 7.2 Integration tests

- Mock authenticated Magpie Web responses through `MagpieUsageService`.
- Assert the Host returns `null` for non-Magpie models and exact snapshots for Magpie models.
- Assert the composer wrapper suppresses the native meter only in the ready Magpie state.
- Assert cleanup removes custom dock entries and refresh subscriptions.

### 7.3 End-to-end tests

- Use static/DOM rendering fixtures for the trigger, panel, category tabs, and narrow viewport structure.
- Do not start DSH, Magpie Desktop, or a development server as part of repository verification.

### 7.4 Verification mapping

| Requirement | Design sections | Verification |
| --- | --- | --- |
| Requirement 1 | §2.3.1, §4.2 | Host gate and native fallback tests |
| Requirement 2 | §3.2-3.3, §5 | Parser, matching, and redaction tests |
| Requirement 3 | §3.1, §7.3 | Context meter DOM/static markup tests |
| Requirement 4 | §2.3.2, §6 | Store generation and lifecycle tests |

## 8. Risks and open items

### 8.1 Risks

- Magpie's `/api/context` is an internal Web API and may change across Magpie versions; the reader must fail closed and remain version-gated by existing Magpie detection.
- Magpie's prompt tokens are gateway-observed/calibrated values, not DSH token-meter values; the panel must not label them as native DSH accounting.
- The response may not contain an in-progress request or retained prompt text; the UI must show the latest bounded data without fabricating live state.

### 8.2 Open items

- Confirm the exact upstream Magpie response shape in the installed version during focused mocked tests; no live Desktop operation is required.
