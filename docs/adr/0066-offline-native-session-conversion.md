# 66. Offline native session conversion

## Status

Accepted.

## Context

Claude and Pi persist conversations in different native JSONL formats. Claude stores a main transcript and independent subagent sidechains, while Pi stores one entry tree per Harness session and has no native subagent relationship. Pi's `parentSession` field describes fork or clone provenance rather than delegation, and Pi custom messages enter model context even when hidden from the UI.

A conversion must produce resumable Pi sessions without claiming semantics Pi does not have. It must also preserve Claude-only records, branches, tool provenance, and malformed complete lines so a future mapping can recover information that the current Pi schema cannot express. Native transcript files contain private prompts, tool output, and source code, and a conversion may race a live Claude writer or an active Pi directory scanner.

Session selection already has an exact, ambiguity-preserving contract. A converter must not introduce a newest-title fallback or a second title grammar.

## Decision

`keeper conversation convert --from claude --to pi <session-reference>` is an offline filesystem operation. It resolves an exact Claude native id or exact case-insensitive current or historical Session title through the shared Session catalog and Session-reference resolver. An explicit main-transcript path remains available. Resolution reads Claude's native artifact tree directly and does not require Keeper jobs, the History index, the daemon, a socket, a subprocess, or a Pi runtime.

One Claude source stream becomes one independent native Pi Harness session: the main transcript produces the root Pi session, and every discovered Claude subagent transcript produces a separate Pi session. A deterministic private Conversion manifest records source digests, target ids and paths, and parent delegation provenance. Pi `parentSession`, Pi branches, and extension-owned subagent records do not stand in for delegation.

The converter emits documented Pi session-format records directly. Conversational records receive native Pi messages when their semantics are known. Every complete Claude source line also receives a namespaced inert Pi `custom` shadow containing exact UTF-8 source bytes and structural provenance. Unknown or unsafe-to-guess records remain inert; they never become `custom_message` entries. A trustworthy Claude compaction boundary and summary may become a native Pi compaction, while an incomplete mapping remains lossless metadata rather than guessed model context.

Output identities and bytes derive deterministically from source identity, source order, and the mapping contract. A catalog-resolved native id is authoritative, and a transcript record that claims a different session id fails validation. The converter snapshots each regular source file through one descriptor, rejects invalid UTF-8, oversized input, an unterminated tail, or a file that changes during the read, and validates the complete Pi graph and message contract before publication.

Publication creates owner-only directories and files, stages complete bytes beside each destination, fsyncs them, and publishes without replacing an existing path. Byte-identical destinations are idempotent no-ops; different bytes are collisions. Child sessions publish before the root session, and the manifest publishes last as the collection's commit marker. A failure removes only artifacts created by that invocation.

## Alternatives considered

- **Embed every subagent as a branch in the root Pi session.** Rejected because resuming the branch would falsely inherit parent-conversation context and erase the child's independent Harness-session boundary.
- **Use Pi `parentSession` for subagents.** Rejected because Pi defines that field for fork and clone provenance, not task delegation.
- **Flatten all streams by timestamp.** Rejected because source append order and parent links are authoritative, timestamps regress, and independent child contexts must remain independent.
- **Keep only the semantic projection.** Rejected because Claude carries fields and record families the Pi schema cannot express, making conversion silently destructive and preventing future remapping.
- **Inject unknown records as hidden custom messages.** Rejected because hidden custom messages still enter Pi's model context and can change resumed behavior.
- **Serialize through a live Pi session runtime.** Rejected because runtime creation can load resources, migrate or append sessions, negotiate models, and introduce effects beyond explicit file reads and writes.
- **Resolve titles by newest match.** Rejected because Session titles are mutable and reusable; distinct exact matches remain ambiguous under the shared resolver.

## Consequences

- Converted main and subagent sessions are independently discoverable and resumable by Pi.
- The manifest, not a fabricated Pi relationship, is the comprehensive traversal surface for one converted Claude session family.
- Lossless custom shadows increase output size, potentially substantially, in exchange for recoverability and forward-compatible remapping.
- Resume rebuilds system prompts, tools, extensions, credentials, and project context from the current Pi environment; a transcript cannot reproduce a Claude specialist's full launch environment by itself.
- Conversion can be retried safely against an unchanged source and destination. A changed source requires a new destination identity or deliberate removal of the prior converted collection rather than silent overwrite.
