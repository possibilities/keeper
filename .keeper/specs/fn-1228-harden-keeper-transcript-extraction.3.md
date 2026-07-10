## Description

**Size:** M
**Files:** src/transcript/claude.ts, cli/transcript.ts, test/transcript-cli.test.ts

### Approach

Five small hardening moves sharing the same files. (a) Per-file fault isolation in
listClaudeSessions page materialization: wrap the per-item inspect in read-and-catch (no
existsSync pre-check — TOCTOU); on failure emit the row from scan-time info (sessionId,
path, bytes, mtime-derived updatedAt) with parse-derived fields null, so total/next_offset
arithmetic is untouched by the failure. (b) Ambiguous-session recovery hint: attribute
each owner to its config root (discoverClaudeProjectsRoots); when duplicate owners share a
bucket name across DIFFERENT roots, recommend --config-dir (project alone cannot
disambiguate); within one root keep the --project hint. (c) Consolidate the two ellipsize
helpers into one exact-max implementation living in src/transcript (importable by both
src and cli runtime; never by the descriptor); preserve each call site's max (72/180/240/300);
the max+2 overshoot goes away; do NOT touch clipTranscriptText (distinct head+tail
clipper). (d) firstHumanPrompt: strip slash-command XML wrappers (command-name,
command-message, local-command-stdout; unwrap command-args content); when empty after
stripping, fall through to the next candidate — benefits both list firstPrompt and
subagent task previews. (e) Date-only --since/--until parse as LOCAL calendar days:
compute bounds from calendar components (until-inclusive = next local midnight - 1),
DST-correct; ISO-with-time and relative-duration forms unchanged; document the local-day
semantics in help.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/transcript/claude.ts:653-654 — the unguarded inspectClaudeFile map
- src/transcript/claude.ts:563-579 — truncateInline (overshoots to max+2) and firstHumanPrompt (shared by list + subagent previews at :665 and :712)
- cli/transcript.ts:562-569 — ambiguity branch; roots come from discoverClaudeProjectsRoots (src/transcript/claude.ts:88-107); transcriptHoldingDirectory is just dirname
- cli/transcript.ts:174-199 — parseTranscriptTime (exported, directly unit-tested); the +86_400_000-1 until logic being replaced

**Optional** (reference as needed):
- cli/transcript.ts:240-244 — compactLine, the exact-max ellipsize survivor
- test/transcript-cli.test.ts:313-319 — existing time-parser cases to extend

### Risks

- Local-time tests must be TZ-independent: build expectations from the same Date components the code uses (or pin TZ) so CI in any zone stays green
- The degraded list row surfaces null title/project to JSON consumers — fields are already nullable, no schema change

### Test notes

Simulate the vanished-file race by deleting a fixture file after scan via a small injected
seam or by pointing one candidate at a directory; assert the other rows survive and
total/next_offset are unchanged. Ambiguity: two roots (config-dir x2) holding the same
bucket + session id -> hint names --config-dir.

## Acceptance

- [ ] A list page whose file disappears between scan and parse returns every other row; the affected row carries scan-time fields with null parse-derived fields; total and next_offset are unchanged by the failure
- [ ] A session id duplicated across two config roots yields a hint naming --config-dir; duplication across projects within one root still names --project
- [ ] One shared ellipsize helper produces exactly-max-length previews at every call site
- [ ] List first-prompt previews show the human ask, never slash-command XML wrappers
- [ ] Date-only --since/--until select whole local calendar days across DST boundaries, covered by TZ-independent unit tests

## Done summary

## Evidence
