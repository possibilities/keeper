## Description

**Size:** M
**Files:** src/session-rename-input.ts, src/transcript/claude.ts, plugins/keeper/pi-extension/rename-command.ts, test/session-rename-input.test.ts, test/pi-rename-command.test.ts, test/transcript-cli.test.ts

### Approach

Define the naming-oriented transcript projection and bounded file-reference expansion before either harness invokes a model. Root code exposes a pure/injected input builder using the existing Claude transcript reader boundary and canonical slug vocabulary; Pi extends its existing isolated conversation allocator without importing Keeper `src/`. Equivalent fixture corpora enforce behavioral parity while preserving Pi's direct model, retry, cancellation, and stale-result semantics.

Human-authored path references are recognized only at a token boundary in ordinary text, with quoted and unquoted project-relative forms plus absolute, home-relative, or `file://` forms only when their canonical target remains inside the session project. Inline/fenced code, emails, assistant text, file-derived text, symlinks, directories, special files, and recursive references never trigger reads. Expansion labels expose project-relative identity only.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `plugins/keeper/pi-extension/rename-command.ts:123-142` — existing skill stripping and simple bounded input assembly.
- `plugins/keeper/pi-extension/rename-command.ts:246-314` — chronological compaction-aware 2:1 conversation allocator to preserve.
- `plugins/keeper/pi-extension/rename-command.ts:679-817` — live/fallback context selection and stale checks that expansion must not weaken.
- `src/transcript/reader.ts:20-95` — harness-neutral transcript discovery and parsing boundary.
- `src/transcript/claude.ts:121-142` — shared-history Claude transcript discovery.
- `src/transcript/claude.ts:368-433` — current record normalization and excluded title metadata.
- `plugins/keeper/pi-extension/keeper-events.ts:385-417` — existing Pi-island path normalization grammar to reuse or drift-test.

**Optional** (reference as needed):
- `src/slug.ts:14-78` — canonical root slug normalization and validation.
- `test/pi-rename-command.test.ts:10-232` — established input allocation and explicit-slug test patterns.
- `test/transcript-cli.test.ts:24-150` — sandboxed Claude JSONL fixtures.

### Risks

Claude transcripts contain branches, compaction records, tool payloads, and command wrappers; a flat JSONL scan can include abandoned or sensitive content. File expansion is a network-egress boundary, so containment and byte accounting must be based on canonical opened regular files rather than unchecked strings. Pi's isolated module graph forbids solving parity by importing the root helper.

### Test notes

Use injected filesystem fixtures covering quoted paths, Unicode whitespace, punctuation, repeated paths, code spans, emails, containment siblings, `..`, absolute/home/file URLs, symlinks, directories, FIFOs represented by injected metadata, binary/NUL input, invalid UTF-8, read races, and truncation. Pin exact UTF-8 byte accounting and run one shared corpus through root and Pi adapters.

### Detailed phases

1. Add a root naming projection that follows the active Claude branch at a fixed transcript cutoff and emits only human, assistant, and compaction sections needed for naming.
2. Add a single-pass path-reference parser and injected bounded reader: eight unique references, eight KiB per file, twelve KiB aggregate, unavailable markers, and project-relative labels.
3. Feed expanded human sections into the existing weighted 16 KiB allocator without allowing file bytes to erase all non-file intent.
4. Mirror the expansion contract inside Pi's isolated rename implementation and add parity/drift fixtures.

### Alternatives

Extending generic transcript rendering is rejected as the sole solution because naming needs active-branch, authorship, cutoff, and byte-allocation semantics that ordinary paginated display does not expose. Recursive or directory expansion is rejected because titles do not justify an unbounded walker.

### Non-functional targets

Non-matching text performs no filesystem calls. Reads stop at their per-file and aggregate limits rather than materializing oversized files. Output is deterministic for identical transcript and file snapshots, contains no canonical absolute paths, and never exceeds the final 16 KiB UTF-8 budget.

### Rollout

The new projection is consumed only by rename paths. Existing transcript list/show behavior and Pi title mutation remain unchanged; failures in reference expansion retain bounded literal/unavailable context and continue naming.

## Acceptance

- [ ] A root API builds a deterministic, 16 KiB-or-smaller naming projection from the active Claude transcript branch at an exact cutoff, excluding abandoned branches, tools, thinking, images, expanded skills, command scaffolding, and native title records.
- [ ] The projection retains chronological human, assistant, and compaction context while giving human text twice the allocation weight of assistant detail.
- [ ] At most eight unique human-authored references expand once from project-contained regular UTF-8 files, with eight KiB per-file and twelve KiB aggregate content limits inside the final input cap.
- [ ] Code spans/fences, emails, assistant/file-derived references, symlinks, outside-project targets, directories, special files, binary/invalid content, and recursive references never cause an unsafe read.
- [ ] An unavailable reference contributes a bounded project-relative marker while other transcript text and valid references continue; no diagnostic exposes an absolute path or file content.
- [ ] Pi uses the same fixture-visible path and allocation contract without importing Keeper root modules or changing its model, explicit-slug bypass, generation, retry, cancellation, stale-result, or exactly-once title behavior.
- [ ] Focused deterministic tests cover active branches, compaction, parity, path grammar, containment, type failures, UTF-8 boundaries, duplicate charging, and all byte ceilings without real harnesses or processes.

## Done summary
Added a naming-oriented Claude transcript projection (active-branch, cutoff-bounded, human/assistant/compaction-only) and a bounded, project-contained @path expansion, mirrored inside Pi's isolated rename extension with shared-fixture parity coverage.
## Evidence
