# Design - External Agent Workspace MCP Control

Status: Draft

## 1. Design goal

Expose a fixed, authenticated MCP tool surface for external Agents while keeping DSH authoritative for session identity, permissions, questions, workspace ownership, and terminal lifecycle. The implementation should be an independent Host feature module that composes existing services rather than adding a second execution/control plane.

## 2. Current architecture evidence

- Host features are registered through `HOST_FEATURES` and receive shared services through `CodingNsHostServices`.
- `CodingNsNativeSessionBridge` exposes native session listing/creation, question and approval requests, injection, and lifecycle subscriptions where supported.
- Terminal startup provides `TerminalProcessService`; existing Host RPC already validates profile/launch payloads and uses this service.
- `src/host/cli-bridge/` already contains an MCP stdio entry and a loopback bridge, but its tools are scoped to adapter-launched sessions and currently focus on subagent, Team, search, and fetch. That bridge is not a general workspace control API and its existing caller contract must remain unchanged.
- Feature registration is the intended extension point; `src/host/index.ts` assembles native services before starting features.

These are initial codebase observations, not a claim that all required DSH operations are supported on every compatible Host version. The implementation Spec must map each operation to a capability route and provide a structured degradation when absent.

## 3. Proposed architecture

```text
External MCP client
        | fixed tools / authenticated transport
        v
Workspace MCP feature (Host)
        | authorize each operation; validate bounds and IDs
        +--> native session bridge / DSH activation and interaction routes
        +--> authorized workspace registry
        +--> TerminalProcessService / existing terminal controller
```

### 3.1 Ownership

| State/capability | Owner | MCP behavior |
| --- | --- | --- |
| DSH session identity, creation, live state | DSH session services | Delegate; never synthesize native IDs or session records |
| Workspace visibility and root resolution | Host workspace registry | Resolve server-side; caller cannot substitute an arbitrary filesystem root |
| Questions and permission decisions | DSH native interaction/approval services | Observe and respond only to exact pending request IDs; never forge approvals |
| Terminal runtime and profiles | Existing terminal services | Read/write only through authorized, live terminal instances |
| MCP connection credential and pending calls | Workspace MCP feature | Scope, revoke, bound, and dispose with feature lifetime |

## 4. Tool surface

Tool names and schemas are implemented as fixed MCP tools; do not expose generic `rpc(namespace, action, payload)`. The listener binds only to `127.0.0.1` and remains inactive unless `CODINGNS_WORKSPACE_MCP_API_KEY` is present. The key is supplied by Host process configuration and is never stored in DSH settings or returned to the browser.

Candidate operations:

- `workspace_list`: list only explicitly authorized workspaces.
- `session_create`: create a native session for a selected authorized workspace.
- `session_list`: return bounded session metadata; content/history is opt-in only if separately authorized and justified.
- `session_continue`: inject/continue a message into an exact authorized session through a supported DSH route. It must not silently start a replacement session.
- `session_ask_user`: request a structured answer through DSH's native user-question UI and return the user's selection. The MCP API cannot enumerate other in-flight provider questions because DSH exposes no supported pending-question query.
- `session_request_permission`: submit a request to DSH's native approval UI and return its user-decided outcome; the MCP caller cannot approve itself or query unrelated pending approvals.
- `terminal_read`: return bounded output from an authorized terminal instance, with cursor/limit semantics.
- `terminal_write`: write bounded input to an authorized terminal instance; this is not equivalent to permissionless command execution.

Native session create/list/prompt/model selection must use the supported DSH 0.2.1 session controller routes. External adapter selection is a CodingNS Host binding applied before an optional initial prompt. Pending-interaction enumeration is deliberately not promised: DSH's public user-question and approval services are request/await APIs, not list/query APIs. Terminal output uses the existing bounded runtime history capture; if a backend has no readable buffer, report that limitation instead of inventing output.

## 5. Trust and authorization model

1. Establish caller scope from the configured `CODINGNS_WORKSPACE_MCP_API_KEY`; compare bearer credentials in constant time. Never accept caller identity, role, session ownership, or workspace root as authoritative payload fields.
2. The key authorizes only a loopback MCP client; workspace IDs must still resolve through DSH's live Workspace Registry. Terminal writes and approval requests remain separate, explicit tools.
3. Revalidate credential and target ownership immediately before each read or mutation, including after any awaited user interaction.
4. Keep the MCP listener local by default unless a separately designed authenticated remote transport is approved. Do not expose unauthenticated LAN/network listeners.
5. Use bounded schemas, canonical IDs, rate/concurrency limits, and structured errors that avoid existence leaks and sensitive payload echoes.
6. DSH approval remains a human/native policy decision. An external MCP client can request/observe approval, not resolve it as allowed.

## 6. Interactions and asynchronous calls

- Long-running session/approval operations return an explicit operation/request identifier and a status that can be polled; do not depend on a single unbounded MCP call.
- Cancellation or disconnect aborts only the associated wait, not an already accepted DSH session unless a dedicated cancellation tool and policy are specified.
- A lost response after mutation is an uncertain outcome. Require reading current state before retrying; do not automatically duplicate session creation, message injection, or terminal input.
- Question replies must be schema-checked against the pending question snapshot and revalidated at commit time.

## 7. Feature lifecycle and compatibility

- Add a Host feature module and register it in `src/host/features/index.ts` only after its dependencies and feature enablement policy are defined.
- Add narrowly scoped optional fields to `CodingNsHostServices` only where composition cannot use existing services.
- Own the transport, credentials, subscriptions, request waiters, and pending-operation map inside the feature lifecycle scope.
- Leave `src/host/cli-bridge/` existing tool schemas and routes backward compatible. Reuse protocol parsing helpers only if their transport-independent contract is explicit; do not broaden adapter-scoped tokens into general workspace credentials.
- Feature shutdown revokes credentials first, settles waiters, closes listeners, then releases subscriptions and other resources.

## 8. Validation strategy

- Unit tests: fixed MCP discovery and schemas; malformed/oversized payloads; identity spoofing; workspace/session isolation; stale/duplicate question response; approval cannot be self-granted; terminal output/input bounds; cancellation and uncertain mutation outcomes.
- Integration tests with fake DSH services: session create/list/continue; native interaction routing; terminal service routing; feature start/stop and credential rotation.
- Regression tests: existing subagent/Team/search/fetch MCP calls retain their tools, credentials, and scope behavior.
- Run focused tests, `pnpm run typecheck`, `pnpm run version:check`, `pnpm run capability:check`, and `pnpm test` as proportionate and safe. Do not start servers or touch Desktop/dsh-web.

## 9. Open decisions before implementation

- External MCP clients must configure the Host URL and the same API key in their own MCP client configuration. The Host process owner provisions and rotates the key by changing `CODINGNS_WORKSPACE_MCP_API_KEY` and restarting that Host.
- The API key grants access to every live DSH workspace visible to this local Host. Per-workspace key scopes are not implemented; do not expose this listener to non-loopback interfaces.
- DSH 0.2.1+ is required for the session-controller create/list/prompt/model-selection route used by this feature.
