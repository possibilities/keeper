## Overview

Replace the scattered, verb-by-verb plan-state routing repairs with ONE shared
resolver, so no current or future plan verb can read/write runtime state from a
lane worktree when the primary repo owns that state. Today the contract lives in
individual verbs, skill prose, and `--project` discipline — which is exactly why a
~6-failure regression cycle kept recurring (fn-984, fn-996 each fixed a subset and
a sibling verb was missed).

THE CONTRACT (panel consensus, code-verified): every verb that reads/writes the
runtime overlay (`state/tasks/<id>.state.json`, `state/epics/…`) or close/audit
artifacts (`state/{briefs,audits,verdicts,followups}/…`) resolves its state-bearing
`ProjectContext` through one function, `resolvePlanStateContext(id, project, format)`,
which: LOCATES the owning def (`--project` else cwd-then-global — sound from a lane
because committed defs are byte-identical), reads the cwd-INDEPENDENT `epic.primary_repo`
field off that def, and returns a context PHYSICALLY ROOTED at the primary repo
(`contextForRoot(realpath(primary_repo))`). A linked worktree never wins state
ownership because ownership is a committed FIELD, not where defs sit. `--project`
stays authoritative for LOCATING; a non-null `primary_repo` owns PHYSICAL state. If
primary lacks the data dir or the id's def → FAIL LOUD (never fall back to the lane).
Code routing (where the worker edits/commits source) stays separate in
`resolveWorkerRepos().targetRepo` — the only thing that follows the lane.

This is the `close-preflight` precedent (close_preflight.ts:124-136) lifted into one
shared seam + pointed at by every state verb. It also kills the unstated
"discovered-project == primary-state-repo" invariant (the physical write site becomes
primary by construction) and fixes the primary-repo-OUTSIDE-configured-roots hole that
no test covers today.

## Quick commands

- `cd plugins/plan && bun test` — pure tier (the resolver + lane-simulation tests)
- `cd plugins/plan && KEEPER_PLAN_RUN_SLOW=1 bun test` — opt-in real-git tier

## Acceptance

- [ ] one `resolvePlanStateContext` seam exists; every runtime-state / close-audit verb routes its STATE through it (code probes stay on cwd / `resolveWorkerRepos().targetRepo`)
- [ ] resolution keys on `epic.primary_repo` read off the committed def (NOT roots-discovery, NOT cwd) → robust when primary is outside configured roots
- [ ] a stateful verb run from a lane with NO `--project` reads/writes state in PRIMARY, never the lane (registry behavioral test over the whole verb set)
- [ ] a default-deny SOURCE guard fails a future verb that touches state without the resolver (display/DEF readers explicitly allowlisted)
- [ ] `--project` stays authoritative for locating; primary missing the def → FAIL LOUD, never a lane write
- [ ] the CLAUDE.md STATE-vs-PATH invariant holds (KEEPER_PLAN_WORKTREE moves only `targetRepo`, never state); re-fold determinism untouched (verb/producer-side only)
- [ ] default `bun test` stays the pure fast tier; new real-git tests opt-in (KEEPER_PLAN_RUN_SLOW)

## Early proof point

Task `.1` — the resolver + the three pure-overlay-writer holes (block/unblock/task-reset)
+ the close-finalize 2-line fix + the default-deny guard. It proves the
`def.primary_repo → contextForRoot` shape generalizes and lands an enforcement gate
BEFORE the higher-churn convergence slice. If the thin-ctx return can't drop in
cleanly, fall back to the close-preflight inline pattern per verb (but that's the
status quo we're escaping).

## References

- A repo-scout inventoried every stateful verb + its resolver; a blind 2-model panel
  (Opus + GPT) converged COLD on this contract and the judge verified the anchors
  against the repo. Corrections it made vs the raw inventory: close-finalize's tally
  is FAIL-SAFE (`force:false` → refuses, not corruption) and `close_finalize.ts:428`
  already computes `primaryRepo` (the fix is a 2-line threading); only `done` falls
  back to cwd on empty-roots while claim/reconcile/resolve-task hard-error;
  `scaffold.ts:915,1034` reliably sets `primary_repo`; `state_repo` is only an
  envelope/reporting field sourced from `primaryRepo` (invocation.ts:64), so keying on
  `epic.primary_repo` alone is correct.
- RESIDUAL RISK to honor: "committed defs are byte-identical lane vs primary" is a
  PROVISION-TIME property — if `primary_repo` changes on primary's main AFTER a lane is
  cut, the lane's def carries a stale `primary_repo`. Safer than a lane write, but real;
  the fail-loud missing-id check is the backstop.
- CONSTRAINT: this is worktree-INFRA → it runs with autopilot worktree mode OFF
  (operator gates it). Worktree lifecycle stays producer-only; re-fold determinism is
  not touched (no fold reads primary_repo to drive FS reads).
