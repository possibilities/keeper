## Description

**Size:** M
**Files:** CLAUDE.md, scripts/lint-claude-md.ts, test/lint-claude-md.test.ts, plugins/plan/CLAUDE.md, docs/skill-authoring.md, docs/plugin-composition-map.md, plugins/keeper/hooks/hooks.json, plugins/keeper/plugin/hooks/context-hint.ts, docs/problem-codes.md

### Approach

Decompose the blanket no-history discipline into a per-genre policy across its enforcement surfaces, and add the ambient discovery hook. Keeper CLAUDE.md rule-0 block: keep the size caps and guardrail purity verbatim; the no-history sentence becomes per-genre — history and rationale have exactly one home (docs/adr, alongside commit messages) and stay banned in CLAUDE.md, README, CONTEXT.md, and code comments; add one-line genre pointers (vocabulary → CONTEXT.md, decisions → docs/adr). Every line added must be offset — the file is at its lint ceiling; fold, don't append. scripts/lint-claude-md.ts: re-point the two provenance-archive prose strings (header comment and emitted epilogue) from the .keeper specs archive to docs/adr + commit messages; scanner logic unchanged; fixtures updated. docs/skill-authoring.md Forward-facing-only section: add the docs/adr sole-exception sentence. plugins/plan/CLAUDE.md doc-style block: extend the sanctioned-exception clause to name docs/adr beside the existing removed-verbs carve-out. New SessionStart hook (context-hint.ts): dep-free node-only, reads the cwd repo's root CONTEXT.md directly; when present and non-empty, emits one line of additionalContext — a pointer plus a read-when trigger ("this repo defines its terms in CONTEXT.md — read it before using or introducing domain terms"); absent, unreadable, or non-git cwd → emits nothing; always exit 0; registered as a second SessionStart entry in hooks.json with the description string updated. CLAUDE.md's hook-count enumeration updates to the final count (fn-1103 lands its hook first — state the count from the live tree, not this spec). plugin-composition-map: hook inventory + SessionStart wiring updated; verify the dated lint-forensics section reads correctly beside the new lint arm. problem-codes: extend the lint_failed entry if it enumerates linters.

### Investigation targets

*Verify before relying.*

**Required**:
- CLAUDE.md rule-0 block and the Hook rules enumeration; run `bun scripts/lint-claude-md.ts` before and after
- scripts/lint-claude-md.ts:11 and :206-207 (the two provenance strings); test/lint-claude-md.test.ts fixtures
- plugins/keeper/hooks/hooks.json SessionStart array; an existing hook (events-writer.ts) for the shape; plugins/plan/plugin/hooks/post-hook.ts for additionalContext emission
- docs/skill-authoring.md Forward-facing-only section (as reshaped by the craft-deltas epic)
- docs/plugin-composition-map.md hook inventory region

### Risks

- CLAUDE.md budget: this task adds genre pointers AND a hook-count word to a ceiling-bound file — net growth must stay within the gate at every commit.
- A non-zero hook exit fails-closed the human's session — the hint hook must swallow every error.

### Test notes

lint-claude-md fixtures green; a hook smoke test is out of scope for the fast tier (no subprocess) — the hook stays trivially readable instead.

## Acceptance

- [ ] The rule-0 surfaces state one consistent per-genre policy: docs/adr and commit messages are the only history homes; CLAUDE.md/README/CONTEXT.md/comments stay history-free; CLAUDE.md passes its own lint
- [ ] The lint-claude-md provenance strings point at docs/adr + commit messages, fixtures green
- [ ] A session starting in a repo with a non-empty root CONTEXT.md receives the one-line hint with a read-when trigger; a repo without one receives nothing; the hook always exits 0
- [ ] hooks.json, its description, the CLAUDE.md hook enumeration, and the composition map agree on the final hook inventory
- [ ] skill-authoring and plugins/plan CLAUDE.md carry the docs/adr exception without forking the canonical discipline wording

## Done summary
Added a dep-free SessionStart context-hint hook that points a session at its repo's non-empty root CONTEXT.md with a read-when trigger (fail-open, always exit 0), and decomposed the blanket no-history rule per-genre across the rule-0 surfaces (CLAUDE.md, plan CLAUDE.md, skill-authoring, lint-claude-md) so docs/adr + commit messages are the sole history homes.
## Evidence
