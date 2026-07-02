## Description

**Size:** M
**Files:** CLAUDE.md, README.md, src/readiness.ts, src/board-render.ts, src/reducer.ts, src/daemon.ts, src/collections.ts, src/readiness-client.ts, src/db.ts, src/await-conditions.ts

### Approach

Three bounded moves. (1) CLAUDE.md line 117: reword the trailing clause "a pre-existing orphaned/squash-merged upstream is a documented stuck-state the parked observability plan owns, never gated here" to state current behavior — the merge-landed observable and `keeper await landed` visibility exist; detection/remediation of orphaned/squash-merged upstream stuck-states is deliberately deferred and stays outside the merge-gate. Forward-facing wording (no epic ids, no past tense), net-neutral-or-negative line count (file is at 117/120), watch the 16384-byte cap, `bun scripts/lint-claude-md.ts` green. (2) README: one short worktree-mode pointer (a sentence or two in the existing architecture-pointer area) within the lean front-door budget. (3) Provenance purge, scoped: remove or rewrite fn-id provenance comments as present-tense behavior statements in src/readiness.ts (sites near lines 299, 316, 516, 577, 598, 772, 1393, 1608), src/board-render.ts (~325, 403, 517), and the fn-1016-tagged comment sites in src/reducer.ts (~3615, 3676, 8879), src/daemon.ts (~5085), src/collections.ts (~894), src/readiness-client.ts (~119, 216, 463, 1669, 1734, 1893), src/db.ts (~909, 1730, 5595), src/await-conditions.ts (~1188). Where a comment carries real WHY beyond provenance, keep the WHY and drop only the fn-id; where it is pure provenance, delete it. Explicit non-goals: src/autopilot-worker.ts (the verdict-core epic owns comments in code it moves), all test files, historical .keeper/specs (history is never rewritten), and any full-src fn-id sweep.

### Investigation targets

**Required** (read before coding):
- scripts/lint-claude-md.ts — the exact size caps and banned-pattern list the CLAUDE.md edit must satisfy
- CLAUDE.md:117 — the one-line autopilot bullet being reworded, in full
- src/readiness.ts:516,1393,1608 — representative provenance sites; calibrate the keep-WHY-drop-tag judgment here first

### Test notes

lint-claude-md.ts green; `bun test` green (comment-only source edits must not disturb any byte-pin test — if one pins a comment, adjust the pin in the same commit and say so).

## Acceptance

- [ ] CLAUDE.md reworded, net-neutral, lint green
- [ ] README worktree pointer added within budget
- [ ] No `\bfn-[0-9]+` matches remain in the scoped source files
- [ ] Non-goal files untouched; `bun test` green

## Done summary
Reconciled docs posture: reworded the CLAUDE.md merge-gate clause to current behavior (lane_merged + keeper await landed make orphaned/squash-merged stuck-states visible; detection/remediation an explicit deferral), added a README worktree-mode pointer, and purged fn-id provenance from readiness.ts + board-render.ts plus the fn-1016 comment sites in six other src files. Comment/docs-only; lint and fast suite green.
## Evidence
