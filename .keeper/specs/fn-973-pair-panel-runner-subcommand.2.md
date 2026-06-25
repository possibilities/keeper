## Description

**Size:** S
**Files:** plugins/plan/agents/panel-runner.md, plugins/keeper/skills/pair/SKILL.md, plugins/plan/CLAUDE.md

### Approach

Collapse the panel-runner agent's hand-rolled orchestration onto the new subcommand. Replace
Step 0 (shell `keeper agent presets resolve`), Step 2 (the `setsid nohup …` launch + the
`T`/`CHUNK`/`MAX_CHUNKS` arithmetic), Step 3 (the `timeout "$CHUNK"` poll loop), and Step 4's
manual tally with: write the prompt file (heredoc, unchanged from Step 1) → `keeper pair panel
start <prompt> [--panel <name>]` → a re-issue loop over `keeper pair panel wait --dir <dir>
--chunk 540` until exit 0 (124 = re-issue), bounded by a backstop count → parse the verdict JSON.
The agent KEEPS the chunk-retry loop (the Bash tool's 10-min single-call cap still forces
chunking) but the loop body is now one clean command, not bespoke shell.

KEEP Steps 5-6 (spawn `plan:panel-judge` with the verdict's per-member `.yaml` paths; return the
judge's answer verbatim) intact. Map a verdict with `ok:false` (or a non-zero terminal from
`wait`) to the existing `PANEL_RUN_FAILED` sentinel block — the agent still owns that
human-facing marker and the scratch path. Add a one-line rule near the top: this runs on macOS
where `setsid`/`timeout`/`gtimeout` do not exist — never shell them; the subcommand owns all
detachment + polling. Keep the "Why blocking Bash, not Monitor" rationale but retarget its
mechanism note to the `wait` call.

Update `plugins/keeper/skills/pair/SKILL.md`: add a `panel start|wait` section (calling
convention, the manifest + verdict stdout contracts, the 0/124/2 exit semantics, where
`PANEL_RUN_FAILED` comes from) and add `panel start|wait` to the `argument-hint` frontmatter.
Keep the new content in its OWN section — fn-971 also edits this file's autoclose section, so a
separate section avoids a merge collision. Verify the `plugins/plan/CLAUDE.md:32` "content-blind
orchestrator" sentence still reads true for the new call shape (the subcommand preserves
content-blindness) and update only if stale.

Forward-facing prose only — no fn-ids, no provenance, no past-tense "used to" narration.

### Investigation targets

**Required** (read before coding):
- plugins/plan/agents/panel-runner.md:44-152 — Steps 0-4 being replaced; lines 154-213 — Steps 4-6 (`PANEL_RUN_FAILED` sentinel + judge spawn + return) to preserve
- plugins/keeper/skills/pair/SKILL.md — the `keeper pair` surface doc + `argument-hint` frontmatter to extend
- plugins/plan/CLAUDE.md:32 — the content-blind orchestrator sentence to verify

**Optional** (reference as needed):
- The task `.1` verdict JSON schema — the exact fields the rewritten Step 4/5 reads

### Risks

- Contract drift: the agent's `wait`-loop + verdict parsing must match task `.1`'s emitted schema exactly. The hard dep on `.1` means it lands first; mirror its actual output, not this spec's sketch of it.
- Merge overlap with fn-971 on pair/SKILL.md — keep edits additive in a separate section; never `rm`.

### Test notes

No automated test (agent + skill prose). Verify by reading the rewritten flow end-to-end against
task `.1`'s real contract; the epic's real `/plan:panel` smoke run is the proof point.

## Acceptance

- [ ] panel-runner.md Steps 0-4 collapsed to: prompt heredoc → `keeper pair panel start` → `wait --chunk 540` re-issue loop → verdict parse; no `setsid`/`timeout`/`gtimeout`/`.status`/`MAX_CHUNKS` shell remains
- [ ] Steps 5-6 (judge spawn with per-member `.yaml` paths, verbatim return) intact; `PANEL_RUN_FAILED` still emitted by the agent on a failed / `ok:false` verdict
- [ ] A top-of-file rule bans shelling `setsid`/`timeout`/`gtimeout` and points detachment/polling at the subcommand
- [ ] pair/SKILL.md documents `panel start|wait` (+ `argument-hint`), content kept in its own section (fn-971 coordination); plugins/plan/CLAUDE.md content-blind line verified/updated
- [ ] Prose is forward-facing (no fn-ids / provenance / past-tense narration)

## Done summary

## Evidence
