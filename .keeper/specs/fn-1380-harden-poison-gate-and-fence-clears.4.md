## Description

**Size:** M
**Files:** src/commit-work/surface.ts, src/collections.ts, src/board-render.ts, src/readiness-client.ts, cli/status.ts, test/commit-work-foundation.test.ts, docs/problem-codes.md

### Approach

The dead-letter gate scopes its blast radius to the record's evidence,
and poison becomes visible. Gate: a blocking row whose trusted
producer-derived evidence names a session/worktree blocks only
mutations in that scope (the waiting-row path already canonicalizes
per-worktree — route evidence-bearing poison through the same scoping);
only genuinely unscopable rows (no trustworthy session/path — true
{raw,file} poison) keep the global block. Scope derives from producer
state, never from attacker-influenced self-reported fields; bound any
rendered reason text. The gate stays fail-closed in kind — this narrows
WHICH rows block, never flips the gate open. Visibility: add a distinct
poison count with blocking-scope context to the needs-human surface and
a board pill (do NOT broaden the dead-letters descriptor's waiting
defaultFilter — it feeds the pill and readiness; a distinct counter
keeps replay semantics intact); needs_human must never read zero while
any row blocks the commit rail. Add the problem-codes.md poison row
(code | meaning | recovery | retry-safe) pointing at the lifecycle
verbs.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/commit-work/surface.ts:766-851 — unresolvedDeadLetterEvidence: the waiting-row worktree scoping via observe()/canonicalMutationPath (:794-800) and the unconditional non-waiting block (:829-832)
- src/collections.ts:619 — DEAD_LETTERS_DESCRIPTOR defaultFilter {status:'waiting'} (wire-level; feeds pill + readiness, NOT the replay pick)
- src/board-render.ts:712 — renderDeadLetterPill
- src/readiness-client.ts:2216 + cli/status.ts:513,570 — the needsHuman.deadLetters counter path
- test/commit-work-foundation.test.ts:870 — the poison fail-closed test this task rescopes

**Optional** (reference as needed):
- docs/adr/0099-poison-lifecycle-and-live-clear-refusal.md — the scoping decision + trusted-evidence rule

### Risks

- This task consumes the status vocabulary and provenance the producer and lifecycle tasks land — its lane must cut after theirs merge (dep chain enforces)
- The fn-1352.2 needs-human render work touches the same accounting surfaces — expect fan-in adjacency; keep counter changes additive
- A scoping bug that unblocks an unscopable row flips the gate fail-open — the rescoped tests must pin the global-block residual class explicitly

### Test notes

Rescope the existing fail-closed test: evidence-bearing poison blocks
only its worktree (foreign-worktree commit passes), unscopable poison
blocks everywhere, the counter reads nonzero in both cases, and the
pill renders scope context.

## Acceptance

- [ ] A blocking row with trusted session/worktree evidence blocks commits only in that scope; a commit in a foreign worktree proceeds
- [ ] A row without trustworthy scope evidence still blocks globally
- [ ] The needs-human surface and board pill show a distinct poison count with blocking-scope context, nonzero whenever any row blocks the commit rail
- [ ] The dead-letters descriptor's waiting filter and replay semantics are unchanged
- [ ] The problem-codes poison row documents meaning and recovery via the lifecycle verbs

## Done summary

## Evidence
