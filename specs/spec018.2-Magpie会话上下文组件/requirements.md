# Requirements - Magpie Session Context Component

Status: Complete

## Introduction

DSH's native context meter exposes a three-part heuristic surface. Magpie can observe the prompt actually sent through its gateway and classify it into system prompt, tools, memory, files, tool results, and conversation content. Users need that richer view inside the session's existing context control, without changing the behavior of sessions that do not use Magpie.

## Glossary

- **System**: CodingNS and the DSH Web client.
- **Magpie session**: A DSH session whose selected model is confirmed by the Host as routed through Magpie.
- **Context snapshot**: Bounded, sanitized metadata returned from Magpie's `/api/context` endpoint for one session.
- **Context component**: The compact percentage trigger and anchored panel rendered below the session composer.

## Scope

### In scope

- Host-side Magpie context retrieval and exact session matching.
- Six-category prompt composition display.
- Cache ratio, used tokens, context window, model, request count, turn count, and request-point display.
- Category filtering and bounded item rows matching the supplied screenshot.
- Native fallback when the session is not Magpie-backed or Magpie data is unavailable.

### Out of scope

- Raw prompt text retrieval or display.
- Magpie writes or model switching.
- Changes to DSH native context accounting for other sessions.
- Live validation against the Desktop profile or a running Desktop process.

## Requirements

### Requirement 1: Detect Magpie-backed sessions

**User story:** As a user, I want the enhanced context component only in sessions using a Magpie model, so unrelated sessions retain their existing behavior.

#### Acceptance criteria

1. WHEN the current session is not confirmed as Magpie-backed THEN System SHALL render the native DSH context component without requesting or displaying Magpie context data.
2. WHEN the current session is confirmed as Magpie-backed THEN System SHALL request the bounded context snapshot for that DSH session and render the Magpie component after valid data is available.
3. WHEN the Host cannot confirm the Magpie model, session identity, Agent identity, or Web API response THEN System SHALL fail closed to the native DSH component.

### Requirement 2: Read and match Magpie context data

**User story:** As a user, I want the context component to represent the selected DSH session rather than an aggregate Magpie view.

#### Acceptance criteria

1. WHEN the Host reads Magpie context data THEN System SHALL exact-match the current session against the allowed DSH and provider session identities plus the expected Magpie Agent identity.
2. WHEN a response contains unknown, oversized, malformed, or prompt-text fields THEN System SHALL discard those fields and retain only bounded metadata needed by the component.
3. WHEN Magpie returns no matching session within its supported lookback and retention limits THEN System SHALL return an unavailable result without guessing from another session.

### Requirement 3: Match the supplied context display

**User story:** As a user, I want the session context control to show the same information hierarchy as the supplied screenshot.

#### Acceptance criteria

1. WHEN valid Magpie context data is available THEN System SHALL show a compact circular percentage trigger with the used percentage and accessible label.
2. WHEN the trigger is opened THEN System SHALL show used tokens, context-window capacity, cache hit information, model/session identity, a proportional composition bar, and the categories `System prompt`, `Tools`, `Memory`, `Files`, `Tool results`, and `Conversation content`.
3. WHEN a category is selected THEN System SHALL filter the bounded content list without changing the aggregate token totals.
4. WHEN request points or content items are available THEN System SHALL show their token sizes, request/round labels, and the selected session breadcrumb in the lower panel.
5. WHEN the panel is opened on a narrow viewport THEN System SHALL remain usable without horizontal page overflow.

### Requirement 4: Preserve native behavior and lifecycle

**User story:** As a user, I want existing sessions and the host UI to remain stable if Magpie is unavailable or the feature is unloaded.

#### Acceptance criteria

1. WHEN the Magpie snapshot is loading, stale, unavailable, or invalid THEN System SHALL preserve the native DSH context component instead of leaving an empty control.
2. WHEN the session changes, the component SHALL discard the previous session snapshot and never display it for the new session.
3. WHEN the CodingNS client feature is disposed or the native composer is replaced THEN System SHALL remove all custom slots, polling, listeners, portals, and injected styles.

## Non-functional requirements

### Performance

1. The Client SHALL coalesce concurrent reads for the same RPC client and session.
2. Refreshing an open Magpie panel SHALL use bounded polling and SHALL not request more frequently than once per three seconds.
3. The Host SHALL apply existing Magpie response and request size limits.

### Reliability

1. Web API authentication, timeout, version, and parse failures SHALL be visible as native fallback rather than fabricated context values.
2. A late response for a previous session SHALL not mutate the current session's component.

### Maintainability

1. Magpie-specific parsing SHALL remain in the Host/contract boundary and SHALL not leak Magpie Web response shapes into the UI.
2. The visual component SHALL consume a stable CodingNS context contract and SHALL not import Magpie or DSH version-specific types directly.

## Success definition

- A Magpie-backed session displays the six-category context panel and request/item details from its exact Magpie context record.
- A non-Magpie session is visually and behaviorally unchanged.
- Focused unit tests cover matching, sanitization, fallback, lifecycle, and the component's key visual states.
- Typecheck, version checks, capability checks, tests, and `git diff --check` pass without starting DSH or touching Desktop.
