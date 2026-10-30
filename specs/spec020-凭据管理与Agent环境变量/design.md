# Design - Credential Management and Agent Environment Variables

Status: Draft

## 1. Overview

### 1.1 Goals

- Keep confidential values under Host ownership and outside browser-readable settings.
- Give users CRUD operations for reusable credential records without read-back of secret values.
- Let external Agent child processes consume selected values through environment variables.
- Preserve the existing model/session protocol by passing only non-secret credential references through it.
- Isolate unsupported providers and DSH versions behind explicit capability diagnostics.

### 1.2 Requirements covered

- `requirements.md` Requirements 1-6.

### 1.3 Technical constraints

- Backend: Node.js Host feature modules, the existing `FeatureRegistry`, `CodingNsRpcTable`, and `cliAdapters` registry.
- Frontend: Existing Client feature registry and settings-card pattern.
- Storage: AES-256-GCM encrypted Host-private file plus a random 32-byte owner-only key file. Normal CodingNS settings remain metadata-free.
- Authorization: Existing Host owner-peer check for mutations; session calls use Host-created session context.
- External integration: Existing `CodingNsCliTurnInput.runtimeEnv` is an internal Host-to-driver field. Browser/Dsh raw `runtimeEnv` is not trusted for credential injection.

## 2. Architecture

### 2.1 System structure

The module has four Host components and one Client component:

1. `credential-store`: encrypted persistence and atomic file replacement.
2. `credential-service`: validates records, serializes writes, returns metadata, and resolves non-secret references.
3. `credentials` Host feature: registers owner-authorized RPC actions and exposes a Host-only resolver to `cliAdapters`.
4. `cliAdapters` integration: reads a credential reference from Host-controlled session input, resolves it immediately before a turn, and passes the resulting environment only to the driver process.
5. `credentials` Client feature: renders the settings card and sends create/update/delete/reference metadata requests.

Data flow:

```text
Client form
  -> owner-authorized credentials/save RPC
  -> Host validation
  -> encrypted Host-private store

Host session reference
  -> credential service resolves selected fields
  -> private in-memory environment map
  -> external Agent child process env

Host/Agent/model/session/UI responses
  <- metadata, IDs, masked status, stable errors only
```

### 2.2 Module responsibilities

| Module | Responsibility | Input | Output |
| --- | --- | --- | --- |
| `CredentialStore` | Encrypt/decrypt the complete credential map | Host records | Host records |
| `CredentialService` | Validate and mutate records; resolve bindings | Owner RPC or Host reference | Metadata or private env map |
| Host `credentials` feature | Lifecycle, RPC registration, owner checks | DSH context and settings | `credentials/*` RPC |
| `cliAdapters` | Apply resolved environment to supported driver turns | Host session reference | Driver `runtimeEnv` |
| Client `credentials` feature | Add/edit/delete forms and reference selection UI | Metadata RPC | User-visible settings |

### 2.3 Lifecycle

The Host feature is enabled by default because it owns the optional settings card and can remain inert without references. It depends on `auth` only if the existing owner-peer helper requires the auth context; it must not depend on a live login session for local credential use.

On start:

1. Construct the store using the configured state directory and an owner-only key file.
2. Load and validate the encrypted record map lazily on the first operation.
3. Register `credentials` RPC and the internal resolver bridge.
4. Register cleanup that aborts pending operations and clears the service cache.

On stop:

1. Reject new mutations and secret resolution.
2. Clear in-memory records and pending promises.
3. Unregister RPC and resolver resources through `context.resources`.

### 2.4 Session integration

The existing `CodingNsCliTurnInput` already carries `runtimeEnv` to drivers. The feature adds a Host-only `credentialRefs` field to the internal request path or derives it from a Host session binding. The Client never supplies a resolved environment map.

The resolution order is:

1. Resolve the session's external adapter and verify it supports runtime environment injection.
2. Read only Host-owned credential reference IDs and binding names.
3. Resolve the current encrypted records immediately before `driver.executeTurn`.
4. Reject missing records, missing fields, duplicate environment names, or invalid binding names.
5. Merge the result with existing Host-required environment values, with credential bindings taking precedence only when their names do not collide with reserved Host variables.
6. Pass the map to the driver. Do not write it into `CodingNsCliSessionRecord`, DSH request/context, event projection, or logs.

The first implementation supports drivers whose process launch path already consumes `runtimeEnv`. Drivers that do not support it declare a centralized capability result and fail before launch. `doubao` remains unsupported until its driver can provide the same Host-only process boundary.

### 2.5 Reserved environment names

The service rejects binding names used for internal bridge credentials, protocol control, or process launch safety. The reserved set is defined in one module and includes existing bridge variables such as `CODINGNS_*`, `NODE_OPTIONS`, `PATH`, `HOME`, `USERPROFILE`, and provider-specific bridge tokens. The exact list is covered by tests and may grow without changing the storage model.

## 3. Components and interfaces

### 3.1 Core components

- `EncryptedCredentialStore`: AES-256-GCM envelope with random IV, authentication tag, version, and encrypted JSON payload.
- `CredentialService`: normalized record map, serialized mutations, metadata projection, and private resolution.
- `CredentialReference`: secret-free session selection object.
- `CredentialPanel`: form that uses blank fields for unchanged values and never hydrates stored secret values.
- `CredentialEnvironmentResolver`: adapter-facing resolver that returns a short-lived in-memory map only.

### 3.2 Data structures

#### 3.2.1 `HostCredentialRecord`

| Field | Type | Required | Description | Constraint |
| --- | --- | --- | --- | --- |
| `id` | string | yes | Stable credential ID | 1-128 chars, lowercase-safe ID pattern |
| `label` | string | yes | User-visible label | 1-160 chars |
| `fields` | record<string,string> | yes | Confidential field values | At least one non-empty value |
| `createdAt` | string | yes | Creation timestamp | ISO timestamp |
| `updatedAt` | string | yes | Last mutation timestamp | ISO timestamp |
| `version` | number | yes | Record format version | Positive integer |

This type is Host-only and must never be exported through Client entry points.

#### 3.2.2 `CredentialMetadata`

| Field | Type | Required | Description | Constraint |
| --- | --- | --- | --- | --- |
| `id` | string | yes | Credential ID | Matches stored record |
| `label` | string | yes | User-visible label | No secret |
| `fields` | array | yes | Field metadata | Names and `hasValue` only |
| `createdAt` | string | yes | Creation timestamp | No secret |
| `updatedAt` | string | yes | Last mutation timestamp | No secret |

Each field metadata item is `{ name: string, hasValue: boolean }`.

#### 3.2.3 `CredentialReference`

| Field | Type | Required | Description | Constraint |
| --- | --- | --- | --- | --- |
| `credentialId` | string | yes | Stored credential ID | Existing record |
| `bindings` | array | yes | Selected field-to-env mappings | Unique env names, valid names |

Each binding is `{ field: string, env: string }`; it contains no value.

#### 3.2.4 `CredentialMutation`

The save request contains `{ id, label, fields }`. Each field value is either a new plaintext value sent only in this explicit mutation request or `{ keepExisting: true }`. The server normalizes it immediately and never returns the submitted value.

### 3.3 RPC contract

Namespace: `credentials`.

#### 3.3.1 `credentials/list`

- Type: RPC.
- Input: `{}`.
- Output: `CredentialMetadata[]`.
- Validation: no secret fields.
- Errors: `CREDENTIAL_STORE_UNAVAILABLE`.

#### 3.3.2 `credentials/save`

- Type: owner-authorized RPC.
- Input: `CredentialMutation`.
- Output: `{ credential: CredentialMetadata }`.
- Validation: IDs, labels, fields, field limits, and `keepExisting` semantics.
- Errors: `CODINGNS_RPC_FORBIDDEN`, `CREDENTIAL_INVALID`, `CREDENTIAL_STORE_UNAVAILABLE`, `CREDENTIAL_NOT_FOUND`.

#### 3.3.3 `credentials/delete`

- Type: owner-authorized RPC.
- Input: `{ id }`.
- Output: `{ deleted: true }`.
- Validation: exact ID match.
- Errors: `CODINGNS_RPC_FORBIDDEN`, `CREDENTIAL_NOT_FOUND`, `CREDENTIAL_STORE_UNAVAILABLE`.

#### 3.3.4 `credentials/resolve`

- Type: Host-internal function, not a Client RPC.
- Input: `CredentialReference`.
- Output: `Readonly<Record<string,string>>` held only in the Host call stack.
- Validation: exact record and field lookup, binding uniqueness, reserved names, and provider capability.
- Errors: `CREDENTIAL_NOT_FOUND`, `CREDENTIAL_FIELD_NOT_FOUND`, `CREDENTIAL_ENV_INVALID`, `CREDENTIAL_ENV_CONFLICT`, `CREDENTIAL_INJECTION_UNSUPPORTED`.

### 3.4 Client panel behavior

The panel lists metadata and offers add/edit/delete actions. An edit form starts with blank secret inputs. An empty field means “keep existing” only when the user has not selected replacement; a separate clear action removes a field. After a successful save, the form state is reset and the submitted strings are no longer retained by the panel.

Session selection UI is shown where external Agent session settings are already edited. It stores only `CredentialReference` objects in the Host session configuration. It does not store environment values, and it does not display a secret preview.

Revision (2026-10-30): The model-selector session binding panel was removed at the user's request. Credentials are now selected per message from the operation (Add) menu's credential command, which inserts a short-lived credential carrier into the draft and lets the Host resolve it immediately before the Agent turn. No model-selector entry creates or edits stored references; existing stored references remain readable for compatibility.

## 4. Data and state model

### 4.1 Relationships

- One credential has many confidential fields.
- One external session may reference zero or more credentials.
- A session reference selects fields and environment names; it does not own the values.
- Deleting a credential invalidates references. New turns fail with a stable missing-reference error until the user removes or replaces the reference.

Credential IDs are stable and never reused automatically. Reusing a deleted ID is allowed only through a new explicit save, which creates a new record version.

### 4.2 Store envelope

The encrypted file contains:

```json
{
  "version": 1,
  "iv": "<base64>",
  "tag": "<base64>",
  "data": "<base64>"
}
```

The key file is a random 32-byte value created with `wx`, stored with mode `0600`, and loaded only by the Host. The store file and parent directory use modes `0600` and `0700`. The key is not derived from a user password in this first version.

### 4.3 State transitions

| State | Meaning | Entry | Exit |
| --- | --- | --- | --- |
| `unloaded` | Store has not been read | Host feature start | First operation |
| `ready` | Valid store is available | Successful read or empty missing file | Host stop or storage failure |
| `unavailable` | Store cannot be safely read/written | Parse, key, or I/O failure | Successful explicit recovery |
| `disposed` | Feature is stopped | Feature cleanup | Never |

### 4.4 Credential reference lifecycle

1. `unbound`: session has no reference.
2. `bound`: session stores IDs and binding names only.
3. `invalid`: a referenced credential or field was deleted; no injection occurs.
4. `resolved`: a short-lived in-memory environment map exists during one driver invocation.
5. `released`: the turn ends and the resolver drops its map.

## 5. Error handling

### 5.1 Error types

- `CREDENTIAL_INVALID`: malformed mutation or binding.
- `CREDENTIAL_STORE_UNAVAILABLE`: encrypted store or key cannot be read or written.
- `CREDENTIAL_NOT_FOUND`: referenced record does not exist.
- `CREDENTIAL_FIELD_NOT_FOUND`: selected field does not exist or has no value.
- `CREDENTIAL_ENV_INVALID`: environment name is invalid or reserved.
- `CREDENTIAL_ENV_CONFLICT`: two bindings map to one environment name.
- `CREDENTIAL_INJECTION_UNSUPPORTED`: selected Agent driver cannot receive Host-only environment values.

### 5.2 Response format

RPC errors use the existing `CodingNsRpcError` envelope. Messages are stable and must not include credential labels combined with secret values, field values, decrypted payloads, or raw provider errors.

### 5.3 Handling strategy

1. Input validation errors are rejected before storage or driver invocation.
2. Store failures leave the prior encrypted file intact.
3. Resolution failures abort only the affected turn.
4. Provider capability failures are reported before any child process launch.
5. Cleanup failures are logged as bounded error codes without serializing secret-bearing objects.

## 6. Correctness properties

### 6.1 No secret crosses the model boundary

For any valid credential record and session reference, the resolved value may appear only in Host memory and the selected Agent child process environment. It must not appear in prompts, DSH messages, session records, projected events, Client responses, logs, or error messages.

Validation: Requirements 2, 4; storage, RPC, redaction, and driver-spawn tests.

### 6.2 Reference-only persistence

For any persisted external session record, credential data consists only of credential IDs, field names, and environment-variable names. Deleting or changing a credential never rewrites a session record with a secret value.

Validation: Requirements 3, 4, 6; session store and serialization tests.

### 6.3 Lifecycle isolation

For any sequence of start, stop, enable, disable, and restart operations, at most one credentials RPC handler and one resolver instance is active, and disposed instances cannot resolve values.

Validation: Requirement 6; feature lifecycle tests.

## 7. Test strategy

### 7.1 Unit tests

- Record normalization, field limits, ID uniqueness, and mutation semantics.
- AES-GCM envelope round-trip, tamper rejection, atomic-write cleanup, and key creation races.
- Metadata projection proves values are absent.
- Environment-name validation, reserved names, duplicate bindings, and missing fields.
- Resolver disposal and no-secret error serialization.

### 7.2 Integration tests

- Host feature start/stop and owner authorization.
- Client panel RPC behavior with blank edit fields and masked metadata.
- `cliAdapters` passing resolved `runtimeEnv` only to a fake supported driver.
- Unsupported driver rejection before spawn.
- Session persistence contains references only.

### 7.3 End-to-end tests

- Use a fake external Agent child process that writes a non-secret proof such as `Boolean(process.env.TEST_SECRET)` to a test-controlled output channel; never print the value.
- Verify prompts, DSH event projections, session records, logs, and RPC responses contain no secret.
- Verify deleting a credential prevents the next turn from launching with it.

### 7.4 Verification mapping

| Requirement | Design sections | Verification |
| --- | --- | --- |
| 1 | §§3.2-3.4 | Store and RPC CRUD tests |
| 2 | §§4.2, 5 | Encryption and redaction tests |
| 3 | §§2.4, 3.2.3 | Binding and session persistence tests |
| 4 | §§2.4, 6.1 | Fake driver environment test and payload audit |
| 5 | §3.4 | Client component tests |
| 6 | §§2.3, 4.3, 6.3 | Feature lifecycle and compatibility tests |

## 8. Risks and open items

### 8.1 Risks

- A compromised or user-modified Agent executable can read any value intentionally bound to its process environment. The feature cannot prevent that by design.
- Provider drivers may use more than one process or an ACP server that forwards environment data internally; each driver must be audited before it is marked supported.
- A local owner-only key file protects against ordinary accidental disclosure but does not protect against a process running as the same OS user.

### 8.2 Open items

- Confirm the exact external Agent session setting UI location after the first Host-only CRUD slice.
- Decide whether a future OS keychain backend should replace or supplement the encrypted file.
- Add provider-specific capability declarations after auditing every driver’s process launch path.
