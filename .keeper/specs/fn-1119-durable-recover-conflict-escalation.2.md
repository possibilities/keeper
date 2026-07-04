## Description

**Size:** S
**Files:** CLAUDE.md, CONTEXT.md

### Approach

Rewrite the CLAUDE.md autopilot paragraph's recover clauses to state the landed
classification: a recover-time content conflict mints the durable `close::<epic>`
`worktree-merge-conflict` sticky (resolver + planner sweeps engage; only
`retry_dispatch` drops it); transient recover degrades stay in the level-cleared
`worktree-recover-*` prefix; recover-row clears are positive-evidence-only (merged /
ancestor / authoritatively-absent — never absence-of-report); the epic probes defer on
inconclusive. This is a prune-and-swap INSIDE the existing paragraph — the file sits
within ~37 bytes and ~13 lines of the lint gate's ceiling, so the edit must be
net-neutral-or-smaller: shorten the clauses the new semantics make redundant (the
auto-clear-scope sentences that are now false) rather than appending. Forward-facing
present tense only; no epic/task ids, no incident narration. AGENTS.md is a symlink to
CLAUDE.md — edit CLAUDE.md only.

Add one line to CONTEXT.md's worktree/merge glossary section defining "Recover pass"
(the per-cycle sweep that aborts interrupted merges, merges done-but-unmerged epic
bases into the default branch, and prunes orphaned lanes), matching the style of the
sibling Lane / Merge-gate / Resolver / Fan-in entries.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- CLAUDE.md — the `## Autopilot` worktree-mode paragraph (the recover auto-clear scope + `worktree-recover*` clauses to swap)
- scripts/lint-claude-md.ts — the size gate constants (byte + line ceilings); measure before and after
- CONTEXT.md — the worktree/merge glossary section and its entry style

**Optional** (reference as needed):
- src/autopilot-worker.ts — the landed pass-2/clear semantics the wording must match (sibling task's diff)

### Risks

- The byte budget is nearly zero; if the swap cannot fit, prune redundant narration elsewhere in the SAME autopilot paragraph — never another section — and keep the lint green.

### Test notes

`bun scripts/lint-claude-md.ts` green is the gate; re-read the paragraph for stale claims
(no sentence may still say recover conflicts auto-clear).

## Acceptance

- [ ] The CLAUDE.md autopilot paragraph states the durable-conflict / transient-level-clear / positive-evidence-clear classification with no remaining claim that a recover content conflict is auto-cleared, and the CLAUDE.md lint script passes.
- [ ] CONTEXT.md's worktree glossary defines the recover pass in one entry consistent with its siblings.

## Done summary
Rewrote the CLAUDE.md autopilot paragraph to the landed recover classification (durable close::<epic> worktree-merge-conflict sticky for content conflicts, transient worktree-recover* level-clear, positive-evidence-only clears, defer-on-inconclusive) net-neutral within the lint gate, and added a Recover pass CONTEXT.md glossary entry.
## Evidence
