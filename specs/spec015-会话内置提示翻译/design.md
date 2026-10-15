# Design

## Data ownership

Attachment metadata owns file identity. A shared formatter selects fixed prose by input language and interpolates metadata unchanged. The CLI turn contract carries the optional language to late driver formatters. Original audit text keeps the legacy source wording.

The existing translator owns language/model selection, placeholder validation, usage, and fallback. An optional internal protection context supplies known literals and permits prose only inside recognized host prompt wrappers. Ordinary user HTML/XML remains protected as before.

Recognize complete path spans before merging known literals, so a working-directory prefix cannot split a longer path. Match identifier literals at token boundaries to avoid protecting fragments of ordinary words.

## Integration boundaries

`agent/pre-step` translates accepted injected messages after downstream middleware returns, independently of whether a human message was translated. Retain source identity and original text in separate metadata; never convert an injected message to a human message.

Translation applies to newly assembled prompts and emitted messages. Existing session history is not migrated; an old catalog is translated when its producer emits it again.

`session.prompt-assembly` exposes a narrow adapter for DSH 0.2.1-alpha.3's `system-prompt/assemble`. The adapter identifies the owning agent and returns a transformed copy. Translate section text and JSON-schema description fields only. Do not translate runtime-context registrations, variables, tool names, schema keys, or enum/default values. DSH's `complete` section restoration remains authoritative.

A bounded cache stores successful context-field translations by source, protected literals, adapter, language, and translator cache key. Failed internal translations retain their original text without entering user-message recovery or being cached. After a failure, remaining queued fields in that assembly retain their originals without further model calls. Retry/send/cancel decisions apply only to actual user submissions. Disable/dispose clears retained translations and cancels outstanding work.

## Compatibility and verification

Unknown capability versions degrade only assembled prompt coverage. Attachment/message translation still works. Legacy versions 0.1.5-rc.3, 0.1.6-alpha.2, and 0.1.7-rc.2 must produce explicit unsupported diagnostics.

Tests inspect actual sent prompts and immutable schema copies, including filenames with Chinese characters/spaces, attachment-only turns, output unaffected by input language, malformed placeholders, truncation, settings changes, and disposal. Use the repository's source loader rather than a build.
