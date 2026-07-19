# 93. Session rename inference stays harness-specific

## Status

Accepted.

## Context

Keeper supports Claude and Pi through different extension boundaries. Pi exposes a native extension command and a lower-level OAuth-aware completion API. Claude exposes plugin skills and hooks, while its built-in `/rename` behavior cannot carry Keeper's transcript projection, path-expansion policy, or output contract.

A shared command implementation would either import Keeper runtime code into Pi's isolated extension or reduce Claude to Pi's host API assumptions. A raw Claude child process would also bypass Keeper's mandatory Account route and could create an unrelated persisted Harness session for a metadata operation.

Session naming may include user-authored `@path` references. Sending only the path text produces weak titles, while unbounded or ambient file expansion can disclose unrelated files, block on special files, or let model-authored text trigger reads.

## Decision

Keeper owns separate `/rename` implementations with one behavioral contract:

- Pi retains its native extension command, direct host inference, fixed cheap Codex model, and `setSessionName()` commit point.
- Claude contributes a plugin skill named `rename` and an exact-command `UserPromptSubmit` hook. The hook returns Claude's native `sessionTitle` output; it never appends transcript records or writes Keeper's database or tmux directly.
- Bare Claude `/rename` derives a bounded naming projection from the parent session's active transcript branch before the command turn. It includes human and assistant text plus compaction context, excludes abandoned branches, tools, thinking, skill bodies, and command scaffolding, and gives human text more input weight than assistant detail.
- Claude inference runs through a dedicated Keeper metadata launch mode using managed Account-route selection and `claude -p` with Haiku, low effort, safe mode, tools disabled, structured output, no persistence, a bounded output buffer, one twenty-second attempt, and no fallback. The launch creates no native child transcript, Keeper Job binding, or Session-catalog entry.
- Explicit canonical slugs bypass transcript reads and inference on both harnesses. Invalid explicit values leave the current Session title unchanged.
- Before final input allocation, both implementations expand eligible `@path` references from human-authored transcript text only. Expansion is single-pass and deterministic: at most eight unique project-contained regular UTF-8 files, at most eight KiB per file, at most twelve KiB total expanded file content, all within the existing sixteen KiB final naming-input cap. Symlinks, directories, special files, recursion, code-span references, outside-project paths, and assistant-authored references never expand. Missing, unreadable, binary, or unsafe references contribute a bounded unavailable marker while other references continue.
- Each implementation snapshots its native session identity, title, transcript position, and cwd before inference and rejects a result when those facts no longer match. Cancellation terminates the Claude process tree or Pi request, and every failure retains the existing title.
- Root code uses Keeper's canonical slug implementation. Pi keeps its isolated mirror and drift tests rather than importing Keeper's runtime graph.

The Claude skill necessarily produces one small command turn because plugin commands are prompts rather than native local callbacks. Rename-input parsing excludes that turn from future naming projections.

## Alternatives considered

- **Use Claude's built-in `/rename`.** Rejected because Keeper cannot apply its transcript weighting, path expansion, managed failure contract, or cross-harness drift tests to the built-in implementation.
- **Write Claude's `custom-title` JSONL directly.** Rejected because it bypasses Claude's live native state and creates a competing transcript writer.
- **Write Keeper's title Projection or tmux title directly.** Rejected because native Harness title records are the source and the existing transcript worker, reducer, and renamer own propagation.
- **Spawn bare `claude -p`.** Rejected because ambient credentials and provider flags can bypass Account-route selection and subscription policy.
- **Share one command module between Claude and Pi.** Rejected because Pi's fail-open extension is an isolated module island; behavioral parity is enforced through shared fixtures and drift tests instead.
- **Expand every path-looking token or recurse into referenced files.** Rejected because model-authored and nested references turn naming into an unbounded local-file egress surface.

## Consequences

- Claude and Pi expose the same explicit-slug, transcript-projection, path-expansion, validation, and fail-open outcomes while retaining native authentication and title mutation.
- Claude rename inference pays bounded process-start latency and one small command turn but does not pollute Session discovery with a child conversation.
- Referenced project content can enter a naming request, so containment, type checks, byte accounting, data delimiters, and no-tools inference remain security boundaries tested independently of prompt wording.
- A missing model, Account route, transcript, native title capability, readable reference, valid completion, or fresh session snapshot leaves the existing Session title unchanged.
- Native title success ends the command contract; Keeper's `TranscriptTitle` projection and tmux rename remain asynchronous consumers.
