# Requirements - Credential Management and Agent Environment Variables

Status: Draft

## Introduction

Users currently have no CodingNS-owned place to manage reusable confidential values for external coding Agents. They need to save usernames, passwords, API keys, and similar values once, select the values needed by a session, and let the Agent process consume them through environment variables without putting the values into the model conversation or ordinary DSH session data.

The feature is Host-owned because the Host launches the external Agent processes and is the only side that can keep secret values out of the browser and model-facing protocol. The Client provides metadata and forms, while the Host owns persistence, access checks, resolution, and process environment construction.

## Terms

- **System**: CodingNS4DSH.
- **Credential**: A Host-owned record containing a user-visible name and one or more confidential fields.
- **Credential field**: A named value such as `username`, `password`, `apiKey`, or a custom secret field.
- **Environment binding**: A mapping from a credential field to a validated environment-variable name.
- **Credential reference**: A non-secret ID used to select a credential and its environment bindings for an Agent session.
- **Agent process**: The external CLI or ACP process launched by the Host for an external Agent session.

## Scope

### In scope

- Create, edit, list, and delete credentials from a settings module.
- Store usernames, passwords, API keys, and arbitrary confidential key/value fields.
- Bind selected fields to environment-variable names for external Agent sessions.
- Resolve references on the Host and inject the resulting values into the Agent child process environment.
- Mask all values in Client responses, session records, diagnostics, logs, and errors.
- Prevent stale bindings and deleted credentials from being used.
- Add focused storage, RPC, UI, and process-injection tests.

### Out of scope

- Returning secret values to the model or writing secrets into prompts, tool arguments, DSH messages, or session history.
- Native DSH Agent environment injection; this requires a separate verified DSH capability.
- Managing secrets in Desktop profiles or changing installed Desktop data.
- OS-specific keychain integration in the first implementation.
- Automatic secret rotation, secret scanning of arbitrary files, or importing provider configuration files.

## Requirements

### Requirement 1: Credential records

**User story:** As a user, I want to save reusable confidential values with a readable label so that I can use them across Agent sessions.

#### Acceptance criteria

1. WHEN the user creates a credential THEN the System SHALL require a non-empty unique ID, display name, and at least one field with a non-empty secret value.
2. WHEN the user edits a credential THEN the System SHALL preserve unchanged secret fields without sending their existing values back to the Client.
3. WHEN the user lists credentials THEN the System SHALL return only IDs, labels, field names, timestamps, and `hasValue` metadata; it SHALL never return field values.
4. WHEN the user deletes a credential THEN the System SHALL remove it from encrypted storage and reject future session references to it.

### Requirement 2: Secure persistence

**User story:** As a user, I want saved credentials protected from normal settings and browser storage so that accidental settings projection does not disclose them.

#### Acceptance criteria

1. WHEN a credential is written THEN the System SHALL store its value only in an encrypted Host-private file with owner-only permissions and an atomic replacement write.
2. WHEN normal CodingNS settings are read, written, projected, or serialized THEN the System SHALL contain no credential value, encrypted payload, encryption key, or secret field value.
3. WHEN the encrypted credential file or key is invalid THEN the System SHALL fail closed with a stable error and SHALL return no partial values.
4. WHEN the Host shuts down or the module is disabled THEN the System SHALL release in-memory credential caches and pending secret resolution state.

### Requirement 3: Environment bindings

**User story:** As a user, I want to choose which credential fields become environment variables so that each Agent session receives only the values it needs.

#### Acceptance criteria

1. WHEN the user saves an environment binding THEN the System SHALL validate the variable name against the platform-independent pattern `[A-Za-z_][A-Za-z0-9_]*`.
2. WHEN a session references a credential THEN the System SHALL resolve only the selected field bindings and SHALL reject missing fields before launching or continuing the Agent process.
3. WHEN two bindings resolve to the same variable name THEN the System SHALL reject the request instead of applying an implicit overwrite.
4. WHEN a session has no credential references THEN the System SHALL preserve its existing environment behavior.

### Requirement 4: Agent process injection

**User story:** As a user, I want the external Agent to read selected credentials through environment variables without receiving them in plaintext through its model-facing session protocol.

#### Acceptance criteria

1. WHEN the Host runs an external Agent turn with valid credential references THEN the System SHALL merge Host-resolved values into the child-process environment in memory.
2. WHEN the Host constructs a model prompt, DSH request/context record, Agent event, session index, or RPC response THEN the System SHALL omit the credential values and the resolved environment map.
3. WHEN a browser or untrusted DSH payload supplies raw `runtimeEnv` values or raw credential values for a turn THEN the System SHALL ignore or reject them; only Host-owned credential references SHALL authorize injection.
4. WHEN a provider cannot support runtime environment injection THEN the System SHALL return a stable capability error before sending the turn to that provider.
5. WHEN a turn ends, is cancelled, fails, or the session is archived THEN the System SHALL not persist or expose the resolved values.

### Requirement 5: Settings UI and access control

**User story:** As a Host owner, I want a clear credential management panel so that I can add and edit secrets while seeing exactly which metadata is retained.

#### Acceptance criteria

1. WHEN the settings panel loads THEN the System SHALL show credential labels and masked field status without requesting stored values.
2. WHEN the user adds or replaces a value THEN the Client SHALL send it only in the explicit save request and SHALL clear the form value after a successful save or cancellation.
3. WHEN the user edits metadata without replacing a field value THEN the Client SHALL send an explicit `keepExisting` marker rather than the old secret.
4. WHEN a non-owner peer calls credential mutation RPCs THEN the System SHALL reject the request.

### Requirement 6: Compatibility and lifecycle

**User story:** As a maintainer, I want the feature isolated behind the module and capability boundaries so that missing support does not break existing Agent sessions.

#### Acceptance criteria

1. WHEN the module is disabled or unavailable THEN existing external Agent sessions SHALL continue without credential injection.
2. WHEN the module starts or stops repeatedly THEN storage, RPC handlers, caches, and session hooks SHALL not be duplicated or leaked.
3. WHEN an older DSH version lacks the verified session hook THEN the module SHALL show a bounded reason and SHALL not enable credential injection.
4. WHEN existing settings and session records are loaded THEN they SHALL remain readable without migration of secret values into normal settings.

## Non-functional requirements

### Security

1. Secret values SHALL not appear in logs, errors, snapshots, browser state, normal settings, DSH session messages, or test failure output.
2. Secret comparisons and credential ID checks SHALL use exact normalized IDs and reject prototype-pollution keys.
3. Writes SHALL be serialized per store and use temporary-file cleanup on success and failure.
4. The threat model SHALL explicitly document that an Agent executable with access to its own environment can read the selected values; the guarantee is against model/session/browser/plaintext transport disclosure.

### Reliability

1. A missing, deleted, or malformed credential SHALL fail the affected turn with a stable error while leaving unrelated sessions usable.
2. Storage read/write failures SHALL leave the previous valid record intact.
3. Credential changes SHALL affect new turns deterministically; existing child processes SHALL not be silently mutated.

### Maintainability

1. Secret storage, metadata RPC, session reference resolution, and process injection SHALL be separate Host components.
2. Business modules SHALL depend on internal credential contracts and shall not import DSH version-specific types directly.
3. Capability and provider support checks SHALL be centralized rather than scattered across drivers.

## Success definition

- A user can create and edit credentials, see masked metadata, and delete them from one settings card.
- A selected external Agent process receives only the requested environment variables.
- Source and tests prove that secret values never cross the model-facing, Client-facing, settings, session-index, log, or error boundaries.
- `pnpm run typecheck`, `pnpm run version:check`, `pnpm run capability:check`, and `pnpm test` pass, subject to unrelated protected workspace changes being recorded separately.
