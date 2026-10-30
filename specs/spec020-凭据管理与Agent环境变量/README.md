# Spec020: Credential Management and Agent Environment Variables

Status: Draft. The user approved the Spec workflow on 2026-10-29. Implementation, commits, publication, and Desktop operations are not authorized by this document.

This Spec defines a Host-owned credential management module for usernames, passwords, API keys, and other confidential values. Credentials can be selected for an external Agent session and exposed to the spawned Agent process as environment variables. Secret values stay on the Host and are never sent to the model, browser, DSH session messages, normal RPC responses, logs, or settings documents.

## Documents

- [Requirements](requirements.md): user-facing behavior, security invariants, and acceptance criteria.
- [Design](design.md): storage, RPC, session injection, lifecycle, and threat model.
- [Tasks](tasks.md): implementation phases and verification evidence.

## Guardrails

- The Client may send a secret only while creating or editing a credential; it may receive metadata and masked status, never the stored value.
- The Host resolves credential references immediately before an Agent turn and builds a private runtime environment in memory.
- The Agent child process can read the environment values by design. The model-facing prompt and DSH session transport cannot.
- `runtimeEnv` values supplied by a browser or DSH payload remain rejected for credential injection; only Host-resolved credential references are authoritative.
- Stored credential values use an encrypted Host-private file with an owner-only key file and atomic writes. They are never stored in the normal settings document.
- The first implementation targets external CLI sessions handled by `cliAdapters`; native DSH Agent sessions and Desktop profiles are outside this Spec unless a later capability is added.
- Do not start DSH servers, operate Desktop profiles, install plugins, commit, push, release, or publish as part of this Spec.
