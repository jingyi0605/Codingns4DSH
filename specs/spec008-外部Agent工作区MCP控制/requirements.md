# Requirements - External Agent Workspace MCP Control

Status: Draft

## Overview

Add a Host feature module that exposes an explicit, authenticated MCP interface for external Agents to operate DSH workspace sessions. The MCP surface should reuse Host-owned session, interaction, permission, workspace, and terminal services rather than creating parallel state or bypassing existing policies.

## Scope

### In Scope

- Start a new DSH session in an explicitly selected managed workspace.
- List and inspect sessions only within the caller's authorized workspace scope.
- Continue an existing session without changing its identity or selected workspace.
- Inspect pending session questions and submit a selection through the existing DSH question-response path.
- Inspect/request permissions through the existing DSH approval path; expose decisions and pending state without granting the external Agent authority to approve itself.
- Read bounded terminal output and submit terminal input through the existing terminal process service.
- Provide an MCP-compatible transport and lifecycle controlled by a Host feature module.
- Require a Host-configured API key before exposing any MCP transport; anonymous access is forbidden.
- Define authentication, authorization, input validation, audit/diagnostic, cancellation, and cleanup requirements.

### Out of Scope

- Operating Desktop profiles, processes, settings, plugins, or caches.
- Reimplementing DSH session storage, Agent execution, question UI, approval policy, or terminal runtime.
- Unrestricted filesystem, process, shell, or network access beyond capabilities already authorized by DSH and the selected workspace/terminal.
- Exposing hidden/private sessions or permitting a caller to forge a DSH identity, workspace, permission result, or terminal ownership.
- Publishing, committing, releasing, or changing dsh-web.

## Terms

- **External MCP client**: an Agent process connecting to the newly exposed MCP server.
- **Caller scope**: Host-authenticated identity and the workspace/session set authorized for that MCP connection.
- **Pending interaction**: a live DSH question or permission request with a DSH-owned request identifier and unresolved status.
- **Terminal input**: bytes/text written to an already authorized terminal instance; it is not an independent shell-execution API.

## Requirement 1: Session lifecycle

1. WHEN the caller requests a new session THEN the Host SHALL create it through the native DSH session activation route and require an authorized workspace.
2. WHEN the caller lists sessions THEN the Host SHALL return bounded metadata from the caller's authorized scope and SHALL NOT return full message history by default.
3. WHEN the caller continues a session THEN the Host SHALL validate that the session is live, belongs to the authorized scope, and is not silently replaced with a new session.
4. WHEN a requested session/workspace is outside the caller's scope or unavailable THEN the Host SHALL return a stable structured error without disclosing unrelated session existence.
5. WHEN optional native session capabilities are missing THEN the feature SHALL report an explainable unavailable result and SHALL NOT prevent unrelated Host features from starting.

## Requirement 2: Questions and permissions

1. WHEN pending questions are queried THEN the Host SHALL expose only unresolved questions belonging to an authorized session, with bounded and validated choices.
2. WHEN an answer is submitted THEN the Host SHALL validate it against the exact pending question and choices, route it through DSH's native question-response mechanism, and reject stale, duplicate, or cross-session request IDs.
3. WHEN permissions are queried or requested THEN the Host SHALL route the request through DSH's native approval service and current approval policy.
4. WHEN an approval decision is pending THEN the MCP caller MAY observe status and await the result, but SHALL NOT approve its own request or fabricate a grant.
5. WHEN the native interaction service is unavailable, the request expires, or the caller disconnects THEN the Host SHALL fail closed and preserve the native service's denial/cancellation semantics.

## Requirement 3: Terminal access

1. WHEN terminal output is read THEN the Host SHALL require ownership/scope validation and return a bounded snapshot or cursor-based chunk.
2. WHEN terminal input is written THEN the Host SHALL require an authorized live terminal instance attached to an authorized workspace/session and enforce input size limits.
3. The MCP surface SHALL NOT start arbitrary shell commands directly; terminal creation/command selection SHALL use the existing terminal profile and launch policy.
4. WHEN terminal authorization or runtime policy is unavailable THEN the Host SHALL reject input rather than falling back to raw process execution.
5. Terminal errors and diagnostics SHALL avoid leaking environment values, credentials, or unbounded terminal contents.

## Requirement 4: MCP transport and lifecycle

1. WHEN enabled THEN the feature SHALL expose a documented MCP tool catalog with fixed schemas and stable tool names; arbitrary RPC/method dispatch is forbidden.
2. The transport SHALL use an explicit authenticated local or otherwise policy-approved endpoint; authentication SHALL be connection/session scoped, revocable, and independent of caller-supplied DSH session IDs.
   The initial implementation SHALL accept the API key only from Host process configuration, bind to loopback, and keep the key out of DSH settings, browser RPC responses, and logs.
3. WHEN credentials rotate, the module stops, or the Host unloads THEN existing credentials SHALL be revoked, pending requests settled, listeners/transports closed, and owned resources released.
4. MCP request sizes, response sizes, wait durations, concurrent calls, and terminal output SHALL be bounded.
5. A missing optional DSH capability SHALL disable only affected tools or operations with a clear diagnostic.

## Requirement 5: Compatibility and safety

1. Existing internal MCP adapters for subagent, Team, search, and fetch SHALL retain their current contracts and caller scoping.
2. The feature SHALL reuse the existing Host feature registry and internal services; it SHALL NOT duplicate session or terminal state.
3. All mutating operations SHALL validate authorization at execution time, not only when the MCP connection is established.
4. Read and mutation results SHALL clearly distinguish accepted, pending, completed, rejected, and uncertain outcomes; network failure SHALL NOT be reported as successful mutation.
5. Tests SHALL prove cross-workspace/session access rejection, forged identity rejection, stale interaction rejection, bounded terminal access, lifecycle revocation, and compatibility with existing bridge behavior.

## Success Criteria

- An external MCP client can discover and use the approved session, interaction, and terminal tools through one documented interface.
- All changes flow through existing native DSH service boundaries and current approval/terminal policies.
- No external caller can select another caller's sessions, answer a stale question, grant its own permission, or write to an unrelated terminal.
- Feature teardown revokes access and releases all resources without affecting existing MCP integrations.
