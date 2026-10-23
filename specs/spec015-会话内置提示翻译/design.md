# Design

## Data ownership

Attachment metadata owns file identity. A shared formatter selects fixed prose by input language and interpolates metadata unchanged. The CLI turn contract carries the optional language to late driver formatters. Original audit text keeps the legacy source wording.

The existing translator owns language/model selection, placeholder validation, usage, and fallback. An optional internal protection context supplies known literals and permits prose only inside recognized host prompt wrappers. Ordinary user HTML/XML remains protected as before.

Recognize complete path spans before merging known literals, so a working-directory prefix cannot split a longer path. Match identifier literals at token boundaries to avoid protecting fragments of ordinary words.

Unquoted paths stop at Chinese prose punctuation (`，。；：！？、`) so adjacent instructions remain translatable. Chinese letters and full-width parentheses remain valid path content. Paths whose names contain those punctuation delimiters must be quoted, enclosed in Markdown code, or supplied as known literals; those explicit forms retain the full path, including spaces and punctuation.

## Integration boundaries

`agent/pre-step` translates accepted injected messages after downstream middleware returns, independently of whether a human message was translated. Retain source identity and original text in separate metadata; never convert an injected message to a human message.

Translation applies to newly assembled prompts and emitted messages. Existing session history is not migrated; an old catalog is translated when its producer emits it again.

`session.prompt-assembly` exposes a narrow adapter for DSH 0.2.1-alpha.3's `system-prompt/assemble`. The adapter identifies the owning agent and returns a transformed copy. Translate section text and JSON-schema description fields only. Do not translate runtime-context registrations, variables, tool names, schema keys, or enum/default values. DSH's `complete` section restoration remains authoritative.

A bounded cache stores successful context-field translations by source, protected literals, adapter, language, and translator cache key. Failed internal translations retain their original text without entering user-message recovery or being cached. After a failure, remaining queued fields in that assembly retain their originals without further model calls. Retry/send/cancel decisions apply only to actual user submissions. Disable/dispose clears retained translations and cancels outstanding work.

Independent system sections, tool descriptions, and parameter descriptions enter the same four-slot queue without waiting for the preceding category to finish. Cache keys sort and retain only configured literals present in the source text, so unrelated workspace paths and tool/schema names do not cause duplicate translations. Queued fields recheck the successful cache before calling the provider to reuse work completed by another session while waiting. Active requests retain their own cancellation scope; model calls already in progress are not shared across sessions.

The plugin-owned `agent_subagent` description and its four parameter descriptions share a Chinese/English catalog with their producer. When input translation targets English and the service explicitly reports no custom rules, unchanged descriptions use the local English version without a provider request. Modified descriptions, other tools, other languages, and custom rules retain the existing translation path. Additional protected schema/workspace literals must still appear unchanged in the local version or force the normal placeholder-preserving path. Translation opt-in, input settings, subagent exclusion, invalidation, and cancellation still gate the entire assembly; user messages never use this catalog.

## Compatibility and verification

Unknown capability versions degrade only assembled prompt coverage. Attachment/message translation still works. Legacy versions 0.1.5-rc.3, 0.1.6-alpha.2, and 0.1.7-rc.2 must produce explicit unsupported diagnostics.

Tests inspect actual sent prompts and immutable schema copies, including filenames with Chinese characters/spaces, attachment-only turns, output unaffected by input language, malformed placeholders, truncation, settings changes, and disposal. Use the repository's source loader rather than a build.
