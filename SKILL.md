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
| `workspace_file_list` | `{ workspaceId, path?, depth? }` | Lists a bounded tree of files and directories. Default depth is 2, maximum is 5. |
| `workspace_file_read` | `{ workspaceId, path, encoding?, limitBytes? }` | Reads workspace-relative files as UTF-8 or base64. Maximum file size is 1 MiB. |
| `workspace_git_status` | `{ workspaceId }` | Returns branch, upstream, ahead and behind counts, and changed paths. |
| `workspace_git_log` | `{ workspaceId, branch?, limit?, skip? }` | Reads at most 100 commits. The branch parameter also accepts a revision or revision range. |
| `workspace_git_diff` | `{ workspaceId, path?, fromRef?, toRef? }` | Views a patch and change counts. Defaults to HEAD versus the working tree. |
| `session_list` | `{ workspaceId?, limit?, offset? }` | Lists bounded metadata only for sessions registered to managed workspaces. |
| `session_history` | `{ sessionId, limit?, cursor? }` | Reads user and assistant text from one managed session, newest page first. Default limit is 20, maximum is 100. Pass `nextCursor` as `cursor` to read older messages. |
| `session_search` | `{ query, workspaceId?, limit? }` | Finds managed sessions whose conversation text contains the query. Query is 1 to 256 characters. Default limit is 10, maximum is 20. |
| `session_create` | `{ workspaceId, adapterId?, modelId?, prompt?, agentId?, priority? }` | Creates a native session and optionally saves an Agent association. External adapters require `prompt`. |
| `session_continue` | `{ sessionId, message, agentId?, priority? }` | Sends a message and returns `messageId`, `status`, `queuePosition`, and `estimatedWaitMs` when the Host supports queue tracking. |
| `message_status` | `{ sessionId, messageId }` | Reads one message receipt, including whether it can be cancelled or reordered. |
| `message_cancel` | `{ sessionId, messageId }` | Cancels an MCP message that is still waiting to be submitted to DSH. |
| `message_prioritize` | `{ sessionId, messageId, priority }` | Changes a waiting message's priority and returns the new position. |
| `session_queue_peek` | `{ sessionId, limit?, includeProcessing? }` | Reads pending MCP messages in processing order. Default limit is 10, maximum is 100. |
| `session_questions` | `{ sessionId }` | Lists bounded unresolved native questions for an authorized session. |
| `session_answer` | `{ sessionId, callId, answer: { answers: [{ id, selected, custom? }] } }` | Answers the exact still-pending question and validates answers against its current options. |
| `session_request_permission` | `{ sessionId, toolName, reason, callId? }` | Requests a native DSH approval decision during an active turn. The caller cannot approve itself. |
| `session_permission_status` | `{ sessionId, requestId }` | Reads the outcome of a DSH-issued request created and retained by this live MCP feature. |
| `terminal_list` | `{ workspaceId, sessionId }` | Lists live terminal metadata scoped to the specified managed workspace and session. |
| `terminal_read` | `{ workspaceId, sessionId, terminalId, limitBytes? }` | Reads a bounded output snapshot, up to 64 KiB, from an existing authorized terminal. |
| `terminal_write` | `{ workspaceId, sessionId, terminalId, data }` | Writes at most 16 KiB of text to an existing authorized terminal. Does not start processes. |

Every session, workspace, and terminal identifier is checked by the Host. Never substitute a filesystem path for a workspace ID or infer that a session belongs to a workspace. If a tool reports an uncertain mutation result, inspect current state before retrying to avoid duplicate prompts or terminal input.

## Session history and search

Both tools only reach sessions in managed workspaces. Archived sessions, sessions outside managed workspaces and ungrouped sessions are not returned, and a request for one fails as `WORKSPACE_MCP_SESSION_UNAVAILABLE`.

`session_history` returns `messages` in time order, each with `seq`, `role` (`user` or `assistant`), `text`, and `time`. Tool calls, images and other non-text events are left out; `omittedWithoutText` counts messages that had no text. Each message is cut at 8 KiB (`truncated: true`) and one page carries at most 256 KiB of text. When `hasMore` is true, pass `nextCursor` as `cursor` to continue backwards. A user message sent through `session_continue` carries the `agentId` that sent it. `sourceKind` is set for messages DSH generated itself, such as a compaction summary.

`session_search` returns `results` of `{ sessionId, workspaceId, snippet }`. DSH searches every session on the Host and returns at most 20, and only then does the Host remove sessions outside managed workspaces. A page can therefore hold fewer results than `limit` while `hasMore` is true. Use a more specific query or pass `workspaceId` to narrow it. If the Host's DSH version does not expose history or search, the tool reports `WORKSPACE_MCP_SESSION_HISTORY_UNAVAILABLE` or `WORKSPACE_MCP_SESSION_SEARCH_UNAVAILABLE`. DSH's Web deployment ships with full-text search off, and then `session_search` fails with `WORKSPACE_MCP_SESSION_SEARCH_DISABLED`. Retrying cannot help: the Host owner must set the `session-query-sqlite` row's `openAt` to `first-search` or `startup` and restart the Host.

## Queue and Webhooks

`agentId` accepts 1 to 256 letters, digits or the characters `. _ : -`, starting with a letter or digit. It identifies a sender for routing and display. Omit it to use the session's saved Agent, if any. The request-level value takes precedence. Keep authorization on the MCP API key.

Priority is an integer from 0 to 100, with a default of 50. Higher priority goes first, and tied messages retain arrival order. Queue positions start at 1. Wait times are estimates. Use `message_status` after an uncertain receipt. After a Host restart, waiting messages resume and ambiguous submissions are kept as `uncertain` without automatic resubmission. Git operations use a five-second timeout and a 10 MiB command output cap. Large patches may be truncated in the response.

The Host owner can opt each Webhook destination into `session.message_queued`, `session.message_dequeued`, `session.queue_changed`, or `session.agent_message_sent`. The last option includes a bounded excerpt of the submitted prompt. Session events include `agentId` and `messageId` when available. The signed envelope includes `eventType` and its existing alias `type`. Retryable delivery failures use 1, 2 and 4 second delays, with bounded `Retry-After` support for HTTP 429.

## Troubleshooting

- **Connection refused:** confirm the Host is running, the Workspace MCP module is enabled, and the client endpoint exactly matches the current status URL.
- **Unauthorized:** verify the client's bearer key matches the latest generated key. Do not rotate just to troubleshoot until you can update the client configuration too.
- **Tool unavailable:** inspect the returned structured error. Some session, question, or approval operations depend on DSH capabilities available in the current Host version.
- **Remote client cannot connect:** direct remote binding is intentionally unsupported. Run the MCP client locally with the Host or use a separately approved secure local forwarding design; do not expose the listener to a LAN interface.
