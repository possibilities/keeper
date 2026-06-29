## Description

**Size:** M
**Files:** src/handoff-worker.ts, plugins/keeper/skills/handoff/SKILL.md, cli/handoff.ts, README.md, src/reducer.ts, test/handoff-worker.test.ts

### Approach

Two coupled parts. (1) INLINE BRIEF: change `buildHandoffPrompt` from emitting a "run
`keeper handoff show <id>`" pointer to emitting the full brief inline as the launch
prompt — `<prefix> <framing> <doc>`, where `<framing>` RETAINS the existing
investigate-then-confirm guard (the brief is the session's REQUEST, NOT a pre-approved
order to execute — same intent as the current pointer wording). The worker already SELECTs
`doc` (`selectActionableHandoffs`), so pass `row.doc` through the `buildPrompt` dep; update
the signature (`buildHandoffPrompt` + the `buildPrompt` interface at :206 + the dep wiring
at :526) and add a COUPLED-CAP assertion that `prefix + framing + doc <= PROMPT_MAX_BYTES`
(the 64KB doc cap + framing stays under the 96KB argv cap — the two caps are now coupled).
`keeper handoff show <slug>` stays an inspection-only verb (nothing keys off the handoff-ee
calling it — the bind is via the `handoff::<slug>` SessionStart spawn name). (2) DOCS SWEEP:
broaden the handoff SKILL.md description to fire on "create a handoff" / "create handoffs"
(front-matter + "When this fires"), disambiguated from authoring a markdown handoff DOCUMENT
(the motivating miss), note that multiple distinct handoffs = multiple `keeper handoff` calls
(the one-call rule is per-handoff), add `--slug`/`--dir` to the flags table + the exit-3
collision row to the exit taxonomy + the `argument-hint`, and rewrite the stale Step-2/Step-3
and lines-20-28 pointer narrative to the inline model. Then the CLI HELP + file-comment
(cli/handoff.ts), the README sections (spawn-name `handoff::<slug>`, `handoff_prompt_prefix`
inline model, dispatcher-worker UUID-ordering rationale, schema-history +v96), and the
remaining stale comment prunes (src/handoff-worker.ts:300-322, src/reducer.ts `handoff_id`
narration). All docs forward-facing only (no provenance/history).

### Investigation targets

**Required** (read before coding):
- src/handoff-worker.ts:300-322 — `buildHandoffPrompt` + the pointer string :316; :206 the `buildPrompt` interface; :526 the dep wiring; :271 `claudeName` (unchanged — verify)
- src/dispatch-command.ts:144 — `PROMPT_MAX_BYTES`; cli/handoff.ts:56 `HANDOFF_DOC_MAX_BYTES` (the coupled caps)
- plugins/keeper/skills/handoff/SKILL.md — front-matter `description` + `argument-hint`, "## When this fires", Step 2 flags table, Step 3, exit taxonomy, lines 20-28
- cli/handoff.ts:2-17 (file comment), :31-50 (HELP), :45 (the `show` "first call" parenthetical)
- README.md:25-27 (spawn-name class), :455-463 (`handoff_prompt_prefix`), ~:3579 (dispatcher UUID-ordering rationale), :1925-1932 (schema history)
- test/handoff-worker.test.ts:115-131 — `buildHandoffPrompt` assertions (update for the inline output + framing)

### Risks

- The investigate-then-confirm framing is LOAD-BEARING — dropping it pushes handoff-ees to execute blind (violates the handoff contract + /hack's confirm beat). Keep it.
- The `buildHandoffPrompt` signature change ripples to the `buildPrompt` interface + dep + tests — update all call sites.
- Docs are forward-facing only (CLAUDE.md rule #0 + the future-facing-docs rule): prune stale narrative, never append history.

### Test notes

- test/handoff-worker.test.ts:115-131 — assert `buildHandoffPrompt` emits `<prefix> <framing> <doc>` (the inline brief, with NO `keeper handoff show` reference) and that the coupled-cap holds for a max-size doc.

## Acceptance

- [ ] The handoff-ee launches with the brief INLINE as its prompt (`<prefix> <framing> <doc>`), NOT a "run `keeper handoff show`" pointer; the investigate-then-confirm framing is retained.
- [ ] A coupled-cap assertion/test guarantees `prefix + framing + 64KB doc <= PROMPT_MAX_BYTES`.
- [ ] `keeper handoff show <slug>` still prints the stored brief (inspection-only).
- [ ] The handoff SKILL.md fires on "create a handoff" / "create handoffs", disambiguated from authoring a markdown handoff document; the flags table + exit taxonomy + `argument-hint` cover `--slug`/`--dir`/exit-3; the pointer narrative (Step 2/3, lines 20-28) is rewritten to the inline model.
- [ ] CLI HELP + file-comment, README (spawn-name, prefix config, dispatcher ordering, schema history +v96), and the remaining stale comments reflect current behavior (forward-facing only).
- [ ] `bun test` green.

## Done summary
Inlined the handoff brief as the launch prompt (<prefix> <framing> <doc>, no keeper handoff show round-trip) with a coupled-cap test pinning prefix+framing+64KB doc under PROMPT_MAX_BYTES; swept SKILL.md/CLI/reducer/README docs to the inline model, the create-a-handoff trigger, --slug/--dir flags, and exit-3.
## Evidence
