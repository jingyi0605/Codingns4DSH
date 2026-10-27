---
name: workspace-mcp
description: Connect a local external Agent MCP client to the authenticated CodingNS Workspace MCP server and use its workspace, session, approval, and terminal tools within their authorization limits.
---

# CodingNS Workspace MCP

Use this Skill when the user asks you to connect an external Agent client to the CodingNS Workspace MCP server, configure that client's MCP entry, or use the Workspace MCP tools.

## Connection

1. Confirm that the MCP client process runs on the same machine as the DSH Host. The server binds only to `127.0.0.1`; it is not directly reachable from another machine.
2. In DSH, open the Workspace MCP module settings. Generate a key to enable the listener, then copy the endpoint and API key into the external client's supported HTTP MCP configuration.
3. Configure the client to send `Authorization: Bearer <key>` and connect to the exact endpoint shown by Host status, in the form `http://127.0.0.1:<port>/mcp`.
4. Use the external client's own documented configuration format. Preserve its other MCP entries and settings. Do not assume one vendor's configuration syntax applies to another client.
5. Verify that the client can list the Workspace MCP tools before using them.

The Host chooses an available port at startup, so the port may change after a Host restart. Check the Workspace MCP Host status and update the client's endpoint if it changed. Rotating the key invalidates the previous key immediately; update the client's secret at the same time. The key is shown only when generated or rotated. Never ask the user to paste it into chat, place it in a repository file, include it in prompts, or print it in logs.

## Tool Catalog

| Tool | Parameters | Access and limits |
| --- | --- | --- |
| `workspace_list` | `{}` | Lists managed workspace names and active session counts. Does not expose filesystem roots. |
| `session_list` | `{ workspaceId?, limit?, offset? }` | Lists bounded metadata only for sessions registered to managed workspaces. |
| `session_create` | `{ workspaceId, adapterId?, modelId?, prompt? }` | Creates a native session in a managed workspace. External adapters require `prompt`; model and adapter are validated. |
| `session_continue` | `{ sessionId, message }` | Queues a message to one exact existing managed session; does not replace it. |
| `session_questions` | `{ sessionId }` | Lists bounded unresolved native questions for an authorized session. |
| `session_answer` | `{ sessionId, callId, answer: { answers: [{ id, selected, custom? }] } }` | Answers the exact still-pending question and validates answers against its current options. |
| `session_request_permission` | `{ sessionId, toolName, reason, callId? }` | Requests a native DSH approval decision during an active turn. The caller cannot approve itself. |
| `session_permission_status` | `{ sessionId, requestId }` | Reads the outcome of a DSH-issued request created and retained by this live MCP feature. |
| `terminal_list` | `{ workspaceId, sessionId }` | Lists live terminal metadata scoped to the specified managed workspace and session. |
| `terminal_read` | `{ workspaceId, sessionId, terminalId, limitBytes? }` | Reads a bounded output snapshot, up to 64 KiB, from an existing authorized terminal. |
| `terminal_write` | `{ workspaceId, sessionId, terminalId, data }` | Writes at most 16 KiB of text to an existing authorized terminal. Does not start processes. |

Every session, workspace, and terminal identifier is checked by the Host. Never substitute a filesystem path for a workspace ID or infer that a session belongs to a workspace. If a tool reports an uncertain mutation result, inspect current state before retrying to avoid duplicate prompts or terminal input.

## Troubleshooting

- **Connection refused:** confirm the Host is running, the Workspace MCP module is enabled, and the client endpoint exactly matches the current status URL.
- **Unauthorized:** verify the client's bearer key matches the latest generated key. Do not rotate just to troubleshoot until you can update the client configuration too.
- **Tool unavailable:** inspect the returned structured error. Some session, question, or approval operations depend on DSH capabilities available in the current Host version.
- **Remote client cannot connect:** direct remote binding is intentionally unsupported. Run the MCP client locally with the Host or use a separately approved secure local forwarding design; do not expose the listener to a LAN interface.
