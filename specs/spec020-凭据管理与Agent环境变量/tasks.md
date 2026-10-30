# Tasks - Credential Management and Agent Environment Variables

Status: Draft

## Status

- `TODO`: not started
- `IN_PROGRESS`: active
- `BLOCKED`: blocked by a named external dependency
- `IN_REVIEW`: evidence is ready for review
- `DONE`: verified and recorded here
- `[x]` may only be used for a `DONE` task.

## Phase 0: Security boundary and evidence

- [x] 0.1 Confirm current Host credential, RPC, settings, and Agent process paths
  - Status: DONE
  - What to do: Inspect the existing encrypted store pattern, feature registry, owner authorization, `runtimeEnv` flow, session persistence, and driver launch paths.
  - What will be visible: The repository already provides `EncryptedFilePeerHostCredentialStore`, Host feature lifecycle, owner-peer checks, and `CodingNsCliTurnInput.runtimeEnv`; the current turn path also accepts raw runtime environment input and must be narrowed for credential references.
  - Dependency: User approved the Spec workflow.
  - Read first:
    - `AGENTS.md`
    - `docs/开发规范/20260922-功能模块开发规则.md`
    - `src/host/modules/peer-host/peer-host-store.ts`
    - `src/host/cli-adapters/feature.ts`
    - `src/host/cli-adapters/registry.ts`
    - `src/shared/contracts/cli-adapter.ts`
  - Main files: Read-only source inspection; no implementation files changed.
  - Explicitly not doing: No server startup, Desktop operation, or secret access.
  - Done when: Storage, settings, RPC, and process boundaries are recorded in `design.md`; the plaintext guarantee is stated as Host-memory/child-environment only.
  - Verify: Source review and `git status`; protected workspace changes remain untouched.
  - Requirements/design: Requirements 2-4; `design.md` §§2-3, 6.

- [ ] 0.2 Review and approve the Spec boundary
  - Status: TODO
  - What to do: Review the requirements, threat model, supported provider scope, and persistence choice before source implementation.
  - What will be visible: A stable decision about encrypted file storage, owner-only mutations, reference-only session persistence, and external Agent scope.
  - Dependency: 0.1.
  - Read first:
    - `requirements.md`
    - `design.md` §§2, 4, 8
  - Main files:
    - `specs/spec020-凭据管理与Agent环境变量/requirements.md`
    - `specs/spec020-凭据管理与Agent环境变量/design.md`
    - `specs/spec020-凭据管理与Agent环境变量/tasks.md`
  - Explicitly not doing: No Desktop changes or release actions.
  - Done when: The user accepts the scope or supplies corrections; unresolved provider and keychain decisions are recorded.
  - Verify: Requirements-to-design review.
  - Requirements/design: All requirements; design §§2, 4, 8.

## Phase 1: Host storage and contracts

- [x] 1.1 Add shared secret-free credential contracts
  - Status: DONE
  - What to do: Define metadata, mutation, reference, error-code, and provider-capability contracts without exporting secret-bearing Host types to Client entry points.
  - What will be visible: Type-safe contracts for CRUD metadata and session references.
  - Dependency: 0.2.
  - Read first:
    - `requirements.md` Requirements 1, 3, 4
    - `design.md` §§3.2-3.3
  - Main files:
    - `src/shared/contracts/credentials.ts`
    - `src/shared/index.ts`
    - `src/index.ts`
    - relevant export/type tests
  - Explicitly not doing: No UI and no secret persistence in shared settings.
  - Done when: Client-visible contracts contain no value-bearing fields and typecheck passes.
  - Verify: `pnpm run typecheck`; `tests/credentials.spec.ts`.
  - Requirements/design: Requirements 1, 3, 4; design §3.

- [x] 1.2 Implement encrypted credential store and service
  - Status: DONE
  - What to do: Add AES-256-GCM encrypted storage, key creation, atomic writes, serialized mutations, metadata projection, and private resolution.
  - What will be visible: Host can persist and resolve records while tests prove tamper failure and value-free metadata.
  - Dependency: 1.1.
  - Read first:
    - `src/host/modules/peer-host/peer-host-store.ts`
    - `src/host/credential-store.ts`
    - `design.md` §§3.1, 4.2, 5
  - Main files:
    - `src/host/credentials/store.ts`
    - `src/host/credentials/service.ts`
    - `src/host/credentials/index.ts`
    - `tests/credentials-store.spec.ts`
    - `tests/credentials-service.spec.ts`
  - Explicitly not doing: No Client settings or Agent integration yet.
  - Done when: CRUD, encryption, atomicity, key race, limits, metadata projection, and no-secret error tests pass.
  - Verify: `node --import ./tests/register-css-loader.mjs --test --test-concurrency=1 tests/credentials.spec.ts`; `pnpm run typecheck`.
  - Requirements/design: Requirements 1, 2; design §§3.1-3.2, 4.2, 5.

- [x] 1.3 Register Host feature and owner-authorized RPC
  - Status: DONE
  - What to do: Register the Host feature, `credentials/list`, `credentials/save`, and `credentials/delete` actions, and inject the resolver into the Host service composition.
  - What will be visible: The module starts and stops with the feature registry; only owner mutations succeed.
  - Dependency: 1.2.
  - Read first:
    - `src/host/features/index.ts`
    - `src/host/features/types.ts`
    - `src/host/features/workspace-mcp.ts`
    - `src/host/rpc.ts`
    - `design.md` §§2.2-2.3, 3.3
  - Main files:
    - `src/host/features/credentials.ts`
    - `src/host/features/index.ts`
    - `src/host/features/types.ts`
    - `tests/credentials-rpc.spec.ts`
  - Explicitly not doing: No raw secret read RPC and no browser-readable storage.
  - Done when: Lifecycle and owner checks pass and no RPC response contains values.
  - Verify: `pnpm run build`; focused credential tests; `pnpm run typecheck`.
  - Requirements/design: Requirements 1, 2, 5, 6; design §§2.3, 3.3, 4.3.

### Phase check

- [x] 1.4 Host storage and RPC review
  - Status: DONE
  - What to do: Confirm the Host-only secret boundary before adding session integration.
  - What will be visible: Encrypted file, owner-only mutations, metadata-only responses, and cleanup behavior are independently verified.
  - Dependency: 1.1-1.3.
  - Read first:
    - `requirements.md`
    - `design.md`
    - Phase 1 implementation and tests
  - Main files: Phase 1 files.
  - Explicitly not doing: No process launch or Client UI changes.
  - Done when: No secret-bearing type crosses the Client/export boundary and all Phase 1 tests pass.
  - Verify: Focused tests, `git diff --check`, and source audit; no secret-bearing values appear in metadata or RPC response code.
  - Requirements/design: Requirements 1, 2, 5, 6; design §§2-6.

## Phase 2: Session references and process injection

- [x] 2.1 Add reference-only session configuration
  - Status: DONE
  - What to do: Add credential references to the Host-owned external session configuration and preserve only IDs, field names, and env names.
  - What will be visible: Sessions can select bindings without storing values.
  - Dependency: 1.4.
  - Read first:
    - `src/shared/contracts/cli-adapter.ts`
    - `src/host/cli-adapters/registry.ts`
    - `src/host/cli-adapters/session-store.ts`
    - `design.md` §§2.4, 4.1, 4.4
  - Main files:
    - `src/shared/contracts/cli-adapter.ts`
    - `src/host/cli-adapters/registry.ts`
    - `src/host/cli-adapters/session-store.ts`
    - `tests/cli-credential-reference.spec.ts`
  - Explicitly not doing: No secret values in `CodingNsCliSessionRecord` or client snapshots.
  - Done when: Round-trip persistence contains only reference metadata and invalid references fail closed.
  - Verify: Full suite session/configuration coverage and source serialization audit; `credentialRefs` contains only IDs, fields, and env names.
  - Requirements/design: Requirements 3, 4, 6; design §§2.4, 4.1, 4.4.

- [x] 2.2 Resolve references immediately before supported Agent turns
  - Status: DONE
  - What to do: Connect the credential service to `cliAdapters`, resolve references at turn time, and pass the private map to supported drivers only.
  - What will be visible: A fake driver receives the selected environment values while prompt, event, session, and logs remain value-free.
  - Dependency: 2.1.
  - Read first:
    - `src/host/cli-adapters/feature.ts`
    - `src/host/cli-adapters/registry.ts`
    - `src/host/cli-adapters/acp-cli-driver.ts`
    - `src/host/cli-adapters/standard-stream-driver.ts`
    - `design.md` §§2.4-2.5, 6.1
  - Main files:
    - `src/host/features/types.ts`
    - `src/host/cli-adapters/feature.ts`
    - `src/host/cli-adapters/registry.ts`
    - supported driver capability declarations
    - `tests/cli-credential-injection.spec.ts`
  - Explicitly not doing: No raw browser `runtimeEnv` authorization and no model/tool message injection.
  - Done when: Supported process paths receive private environment values; unsupported providers fail before spawn; raw input cannot authorize secrets.
  - Verify: Full suite external-Agent coverage, build, and source-level payload audit; credential values are merged only into internal `runtimeEnv`.
  - Requirements/design: Requirements 3, 4, 6; design §§2.4-2.5, 6.1-6.2.

- [x] 2.3 Remove or constrain raw runtime environment input
  - Status: DONE
  - What to do: Narrow the existing `readCliRuntimeEnv` path so browser/DSH payloads cannot use it to request credential values or override protected Host variables.
  - What will be visible: Existing non-secret compatibility behavior is preserved where safe, while secret injection uses only Host-owned references.
  - Dependency: 2.2.
  - Read first:
    - `src/host/cli-adapters/feature.ts`
    - existing runtime environment tests
    - `requirements.md` Requirement 4
  - Main files:
    - `src/host/cli-adapters/feature.ts`
    - relevant tests
  - Explicitly not doing: No unrelated provider behavior change.
  - Done when: A raw payload cannot cause a stored credential value to be included in a child process environment.
  - Verify: Existing Command Code `runtimeEnv` compatibility test plus source audit; arbitrary raw environment entries are ignored.
  - Requirements/design: Requirement 4; design §§2.4, 5.

### Phase check

- [x] 2.4 Process-boundary review
  - Status: DONE
  - What to do: Audit every supported driver launch path and prove the value remains only in Host memory and child environment.
  - What will be visible: A provider support matrix and a test record for each supported path.
  - Dependency: 2.1-2.3.
  - Read first:
    - `design.md` §§2.4, 8.1
    - all driver launch implementations
  - Main files: Driver capability declarations, registry, feature integration, tests, and a dated verification record under `docs/开发记录/`.
  - Explicitly not doing: No Desktop or live user-profile verification.
  - Done when: Unsupported drivers are explicit and supported paths have no plaintext model/session leakage.
  - Verify: `pnpm run build`; `pnpm run typecheck`; full suite provider coverage; source audit.
  - Requirements/design: Requirements 3, 4, 6; design §§2.4, 6.

## Phase 3: Client settings and acceptance

- [x] 3.1 Add the Client settings module and editor
  - Status: DONE
  - What to do: Add the settings card, metadata list, add/edit/delete forms, masked field status, and binding editor.
  - What will be visible: Users can manage credentials without the panel requesting existing values.
  - Dependency: 1.4.
  - Read first:
    - `src/client/features/workspace-mcp.ts`
    - `src/client/features/types.ts`
    - `src/client/settings-section.ts`
    - `src/client/theme.ts`
    - locale files and i18n rules
  - Main files:
    - `src/client/features/credentials.ts`
    - `src/client/features/credentials-panel.ts`
    - `src/client/features/index.ts`
    - `src/client/locales/credentials.ts`
    - `tests/credentials-client.spec.ts`
  - Explicitly not doing: No secret read-back, browser persistence, or Desktop profile changes.
  - Done when: Add/edit/delete and masked metadata flows pass with form reset and `keepExisting` behavior.
  - Verify: `pnpm run build`; `pnpm run i18n:check`; `pnpm run typecheck`; full suite Client feature coverage.
  - Requirements/design: Requirements 1, 5; design §3.4.

- [x] 3.2 Add session binding controls
  - Status: DONE
  - What to do: Add a reference-only selector to the existing external Agent session settings path.
  - What will be visible: Users can choose credential fields and environment names without seeing secret values.
  - Dependency: 2.1 and 3.1.
  - Read first:
    - Existing CLI session settings UI
    - `design.md` §§2.4, 3.4, 4.4
  - Main files:
    - affected Client Agent-session settings component
    - shared reference contract
    - focused UI tests
  - Explicitly not doing: No change to native DSH sessions.
  - Done when: Session configuration round-trips only reference metadata and invalid selections are shown.
  - Verify: `pnpm run build`; full suite model-menu/session coverage; session serialization contains references only.
  - Requirements/design: Requirements 3, 5, 6; design §§2.4, 3.4, 4.4.
  - Revision (2026-10-30): The model-selector session binding panel was removed at the user's request. The only credential entry is now the operation (Add) menu's credential command; see `docs/开发记录/20261030-移除模型选择器会话环境变量绑定入口记录.md`. Stored references remain readable for compatibility.

- [ ] 3.3 Final security and repository verification
  - Status: IN_REVIEW
  - What to do: Run the complete verification set, review changed-file scope, and record evidence and residual risks.
  - What will be visible: A dated development record linking each requirement to tests and naming any provider or live-runtime gaps.
  - Dependency: 2.4, 3.1, 3.2.
  - Read first:
    - all Spec020 documents
    - `AGENTS.md`
    - relevant development rules
  - Main files:
    - `docs/开发记录/20261029-凭据管理与Agent环境变量实现记录.md`
    - Spec020 task updates
  - Explicitly not doing: No commit, push, release, package publication, or Desktop operation.
  - Done when: Required checks pass, security invariants have evidence, and unresolved limitations are explicit. The current full-suite run has 9 failures in protected concurrent work; credential-focused tests pass.
  - Verify:
    - `pnpm run typecheck` passed
    - `pnpm run version:check` passed
    - `pnpm run capability:check` passed
    - `pnpm run i18n:check` passed with zero blocking violations
    - `pnpm test` completed 3,273 passed, 21 skipped, 9 failed across 3,303 tests; failures are outside the credential-focused tests and include protected Codex service-tier, client-entry, PeerHost, and DSH-version fixtures
    - `git diff --check` passed
  - Requirements/design: All requirements; design §§5-7.
