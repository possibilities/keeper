## Description

**Size:** M
**Files:** src/daemon.ts, test/daemon.test.ts, README.md, CLAUDE.md

The producer: a sibling daemon sweep that detects the sticky
`worktree-merge-conflict` row, sends the planner a resolve+unstick brief over the
bus, and mints the `MergeEscalationAttempted` event (task .1) — mirroring the
block-escalation flow. Notifies only; never clears the sticky row.

### Approach

Factor the bus-send + `keeper bus wake` core out of `notifyPlannerOfBlock`
(`src/daemon.ts:4667`) into a shared `notifyPlanner(target, body)`, keeping the
block path byte-identical (the block-specific body assembly + log string stay in
the block wrapper; the existing block tests are the byte-identical guard). Add
`selectPendingMergeEscalations` (mirror `selectPendingBlockEscalations:510`)
reading `dispatch_failures` on MAIN's writable connection for rows WHERE
`verb='close'` AND `merge_escalated_at IS NULL` AND the reason's leading token
(the text up to the first `:`) is EXACTLY `worktree-merge-conflict` — never a
`worktree-merge` prefix, so the excluded `worktree-merge-lock-timeout` /
`worktree-merge-local-timeout` siblings don't match. Add a pure
`shouldEscalateMergeConflict(reason)` gate and a pure `buildMergeEscalationBody`
that parses the source + base branches out of the reason
(`worktree-merge-conflict: merging <source> into <base> — <stderr>`: split on the
first ` — ` em-dash, then ` into `) and derives the base worktree path via
`worktreePathFor(row.dir, baseBranch)` (`src/worktree-plan.ts:165`; `row.dir` is
the repo root). The brief's recipe: `cd <worktree>` → `git merge --no-ff
<source>` (NOT `--squash`/rebase — those re-conflict on retry) → resolve merging
BOTH intents (never pick a side) → run the epic's tests/build → commit the merge
commit → `keeper autopilot retry close::<epic>`; plus the guardrail: leave the
sticky and ping the human when the conflict isn't mechanically clear (state
machine / schema / security / transaction boundaries). Add
`runMergeEscalationSweep(deps)` (classify-then-send; re-read that the row is still
present + marker NULL immediately before the send to narrow the clear-mid-sweep
window; wrap `notifyPlanner` in the same defense-in-depth try/catch that records a
terminal/`send_failed` outcome and never aborts the tick) and
`runMergeEscalationSweepTick` on the same 60s heartbeat as the block tick
(`:4831`/`:4878`). After the send, mint `MergeEscalationAttempted{outcome}` via the
`mintBlockEscalationEvent`-style helper (`:4570`); task .1's fold sets the marker
only on a terminal outcome. The sweep NEVER mints `DispatchCleared` and never
clears the sticky row. Then update the docs per the epic's Docs gaps.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:4667 — `notifyPlannerOfBlock` (the refactor target; extract the send/wake core).
- src/daemon.ts:510 — `selectPendingBlockEscalations` (selector template).
- src/daemon.ts:581, :596 — `shouldEscalateBlockedCategory` / `buildBlockEscalationBody` (gate + body templates).
- src/daemon.ts:737 — `runBlockEscalationSweep` (orchestration template: classify pass → notify → mint).
- src/daemon.ts:4570 — `mintBlockEscalationEvent` (synthetic-event insert helper to reuse).
- src/daemon.ts:4831, :4878 — `runBlockEscalationSweepTick` + its heartbeat timer.
- src/autopilot-worker.ts:2554 — the exact `worktree-merge-conflict: merging ${source} into ${branch} — ${stderr}` reason format to parse (pin it with a test).
- src/worktree-plan.ts:165 — `worktreePathFor(repoDir, branch)`.
- src/worktree-git.ts:89, :465 — `git merge --abort` runs on conflict, so the base worktree is left CLEAN; the brief must RE-RUN the merge to recreate markers, not look for existing ones.

**Optional** (reference as needed):
- src/bus-wake.ts — `keeper bus wake` resume semantics (`queued_for_wake` → terminal one-send).
- README.md:3112, :2667, :3272, :1128 — the doc paragraphs to update.
- CLAUDE.md:116 — the worktree guardrail line to extend.

### Risks

The shared-helper refactor MUST keep the block path byte-identical — the proven
flow; the existing block-escalation tests staying green is the guard. The reason
parser is coupled to the mint-string format; pin the format with a test and
degrade a parse-miss to a human-actionable body ("resolve `close::<epic>`
manually") rather than throwing the sweep. Fail-open discipline: every sweep edge
degrades to a recorded outcome and never throws into the daemon loop; spawns are
async `Bun.spawn`, never `Bun.spawnSync`.

### Test notes

Clone the `makeDeps`-injected sweep harness at `test/daemon.test.ts:2720-3081`.
Cases: gate NEGATIVE (`worktree-merge-lock-timeout` / `worktree-merge-local-timeout`
/ `worktree-finalize-non-fast-forward` / `worktree-recover*` do NOT escalate);
selector picks only `verb='close'` + `merge_escalated_at IS NULL` + exact-token
rows; body parses source/base + derives the worktree path, includes `--no-ff`
(and forbids `--squash`/rebase), the run-tests-before-`retry` + dual-intent +
escalate-to-human guardrails; the sweep mints `MergeEscalationAttempted{outcome}`
and never `DispatchCleared`; a `send_failed` leaves the marker unset
(re-sweepable); a delivered/`queued_for_wake` escalates exactly once; a parse-miss
degrades to a non-throwing human-actionable body; the existing block tests stay
green.

## Acceptance

- [ ] The bus-send/wake core is factored into a shared `notifyPlanner(target, body)`; the existing block-escalation tests stay green (block path byte-identical).
- [ ] `runMergeEscalationSweep` selects only `verb='close'` rows with `merge_escalated_at IS NULL` and an EXACT `worktree-merge-conflict` reason token; the lock-timeout / local-timeout / finalize-non-fast-forward / recover reasons are NOT escalated (negative tests).
- [ ] The brief carries the `git merge --no-ff <source>` recipe (forbids `--squash`/rebase), a correctly-derived worktree path, and the run-tests-before-`retry` + dual-intent + escalate-to-human-when-unclear guardrails.
- [ ] The sweep mints `MergeEscalationAttempted{outcome}` and never `DispatchCleared` — the sticky row is cleared only by `retry_dispatch`.
- [ ] A `send_failed` outcome leaves the marker unset so the next sweep retries; a delivered/`queued_for_wake` outcome escalates exactly once.
- [ ] A parse-miss on the reason string degrades to a human-actionable body and never throws the sweep.
- [ ] CLAUDE.md's worktree guardrail is extended with the gate-is-a-column-not-a-table + sweep-is-read-only-wrt-the-sticky-row rule; README escalation/schema paragraphs updated per the epic Docs gaps.

## Done summary

## Evidence
