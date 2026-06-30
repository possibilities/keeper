## Description

**Size:** S
**Files:** README.md, CLAUDE.md, cli/autopilot.ts

### Approach

Document the cross-epic upstream-merge gate, each doc in its existing style.

- **README.md** worktree section (~3285-3344): weave a sentence into the lane-cutting
  prose (~3313-3316) — before cutting a dependent epic B's lane the producer probes
  each same-resolved-repo upstream A's merge state against the LOCAL default branch (a
  per-cycle read in `loadReconcileSnapshot`), entirely ephemeral (no `DispatchFailed`,
  no durable signal, a skip-this-cycle deferral); same architectural slot as the
  armed-eligibility gate (parenthetical pointer ~2422-2447) but worktree-specific;
  pre-existing stale lanes (cut before the gate, or before the upstream merged) are
  document-and-defer — no retroactive repair. Match the dense inline-prose style (no
  new sub-section / bullet list).
- **CLAUDE.md** worktree bullet (line 118): append ONE forward-facing sub-clause — the
  cross-epic upstream-merge gate is EPHEMERAL and PRODUCER-ONLY (probes merge state in
  `loadReconcileSnapshot` each cycle, MUST NEVER mint a `DispatchFailed` or sticky row;
  a deferred lane re-evaluates next cycle, no operator action). Extend the existing
  sentence via its semicolon / em-dash pattern, do not start a new bullet.
- **cli/autopilot.ts** worktree help (~86-92): optional one-liner — dependent epics
  whose same-repo upstreams aren't merged are deferred each cycle (no error, no manual
  retry).

Keep `bun scripts/lint-claude-md.ts` green.

### Investigation targets

**Required** (read before coding):
- README.md:3285-3344 — worktree-mode prose to extend; :2422-2447 — armed-eligibility gate (the pointer target)
- CLAUDE.md:118 — the worktree-mode invariant bullet to extend
- cli/autopilot.ts:86-92 — worktree sub-command help

**Optional** (reference as needed):
- scripts/lint-claude-md.ts — the CLAUDE.md size / re-narration gate

### Risks

- If fn-1013's worktree-disabled docs land first, CONSOLIDATE both non-error-deferral notes in one README place rather than appending two paragraphs.
- CLAUDE.md is size-gated and bans re-narration — add one forward-facing rule line, not a walkthrough.

### Test notes

`bun scripts/lint-claude-md.ts` green; no behavioral tests.

## Acceptance

- [ ] README worktree section describes the ephemeral cross-epic upstream-merge gate in the existing inline-prose style, with the armed-eligibility parenthetical pointer and the document-and-defer note for pre-existing stale lanes
- [ ] CLAUDE.md worktree bullet carries one forward-facing sub-clause: the gate is ephemeral / producer-only and never mints a sticky row; `lint-claude-md` green
- [ ] cli/autopilot.ts worktree help notes the silent per-cycle deferral (or a one-line equivalent)
- [ ] If fn-1013 doc changes have landed, the two non-error-deferral notes are consolidated, not duplicated

## Done summary

## Evidence
