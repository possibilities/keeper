# 66. Offline native session conversion

## Status

Accepted.

## Context

Claude and Pi persist conversations in different native JSONL formats. Claude stores a main transcript and independent subagent sidechains, while Pi stores one entry tree per Harness session and has no native subagent relationship. Pi's `parentSession` field describes fork or clone provenance rather than delegation, and Pi custom messages enter model context even when hidden from the UI.

A conversion must produce resumable target sessions without claiming semantics the target does not have. It must preserve source-only records, branches, tool provenance, and malformed complete lines so a future mapping can recover information that the current target schema cannot express. Native transcript files contain private prompts, tool output, and source code, and a conversion may race a live writer or scanner.

Session selection already has an exact, ambiguity-preserving contract. A converter must not introduce a newest-title fallback or a second title grammar. Neither target runtime is an acceptable serializer: loading one may discover configuration, migrate or append sessions, negotiate models, or perform unrelated effects.

## Decision

`keeper conversation convert` supports the `claude → pi` and `pi → claude` harness pairs as offline filesystem operations. Both resolve exact native ids or exact case-insensitive current or historical Session titles through the shared Session catalog and Session-reference resolver; `--source-path` selects an explicit artifact. Resolution reads native artifact trees directly and does not require Keeper jobs, the History index, the daemon, a socket, a subprocess, network access, or either harness runtime.

For Claude→Pi, one Claude source stream becomes one independent native Pi Harness session: the main transcript produces the root Pi session, and every discovered Claude subagent transcript produces a separate Pi session. A deterministic private Conversion manifest records source digests, target ids and paths, and parent delegation provenance. Pi `parentSession`, Pi branches, and extension-owned subagent records do not stand in for delegation.

For Pi→Claude, one Pi entry tree becomes one Claude transcript graph. Deterministic Claude UUIDs preserve every valid Pi parent edge after context-free metadata nodes collapse to their nearest linked ancestor. An explicit `last-prompt` selects Pi's active leaf—its append-time leaf, or a valid explicit leaf target when present—even when an abandoned branch was serialized later. Pi tool results link only to ancestral calls. Pi compactions become a linked Claude compact boundary and compact-summary pair only when the kept entry is a valid ancestor.

Known conversational records receive native target messages. Pi thinking, extension state, labels, model changes, unknown records, and malformed complete lines never become guessed Claude context. Every Pi source line receives an unlinked namespaced Claude shadow with its exact UTF-8 bytes and structural provenance; every Claude source line receives an inert Pi `custom` shadow. Unknown Pi top-level record types are deliberately outside Claude's linked `parentUuid` graph, while unknown Claude data never becomes a Pi `custom_message`.

Output identities and bytes derive deterministically from source identity, source order, and the direction's mapping contract. A catalog-resolved native id is authoritative, and a conflicting source header or record fails validation. The converter snapshots each regular source file through one descriptor, rejects invalid UTF-8, oversized input, an unterminated tail, or a file that changes during the read, and validates the complete target graph and message contract before publication.

Publication creates owner-only descendant directories and files under an owned, non-shared target root. It stages complete bytes beside each destination, fsyncs them, and publishes without replacing an existing path. Byte-identical destinations are idempotent no-ops; different bytes are collisions. Target sessions publish before the manifest, which is the collection's commit marker. A failure removes only artifacts created by that invocation; an exact concurrently committed manifest preserves the already-complete shared collection.

## Alternatives considered

- **Embed every Claude subagent as a Pi branch.** Rejected because resuming the branch would falsely inherit parent-conversation context and erase the child's independent Harness-session boundary.
- **Use Pi `parentSession` for subagents.** Rejected because Pi defines that field for fork and clone provenance, not task delegation.
- **Flatten either source by timestamp or file order alone.** Rejected because source parent links are authoritative, timestamps regress, Pi has abandoned branches, and independent Claude child contexts must remain independent.
- **Keep only the semantic projection.** Rejected because each harness carries fields and record families the other cannot express, making conversion silently destructive and preventing future remapping.
- **Inject unknown records as hidden messages.** Rejected because hidden/contextual messages can change resumed behavior. Lossless shadows remain inert and outside the target model-context graph.
- **Serialize through a live harness runtime.** Rejected because runtime creation has effects beyond explicit source reads and destination writes.
- **Resolve titles by newest match.** Rejected because Session titles are mutable and reusable; distinct exact matches remain ambiguous under the shared resolver.

## Consequences

- Converted Claude main and subagent streams remain independently discoverable and resumable by Pi; converted Pi branches remain selectable inside one resumable Claude transcript.
- The manifest is the comprehensive provenance surface for a conversion, including relationships the target cannot natively model.
- Lossless shadows increase output size, potentially substantially, in exchange for recoverability and forward-compatible remapping.
- Resume rebuilds system prompts, tools, extensions, credentials, and project context from the target's current environment; a transcript cannot reproduce the source session's full launch environment by itself.
- Conversion is retry-safe against unchanged source and destination bytes. Changed source content collides with a prior deterministic destination rather than silently replacing it.
