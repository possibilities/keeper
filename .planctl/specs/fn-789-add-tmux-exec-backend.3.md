## Description

**Size:** M
**Files:** src/restore-worker.ts, src/daemon.ts, src/reducer.ts, src/types.ts, test/restore-worker.test.ts, test/reducer-projections.test.ts

### Approach

Close the human-session gap (first-pane included) with a self-gating snapshot
poller — NO new worker, NO control mode. On the restore-worker's EXISTING
data_version pulse (it already reads the live jobs set), add a gate: any live job
with `backend_exec_type='tmux'` AND `backend_exec_session_id IS NULL`? If yes,
spawn `tmux list-panes -a -F '#{pane_id}\t#{session_name}'` (injectable spawn,
ENOENT/non-zero → skip silently — no tmux server means nothing to resolve) and
post `{kind:"tmux-pane-snapshot", pairs:[{pane_id, session_name}]}` to main. Main
— already the sole synthetic-event writer — mints ONE event with a NEW
hook_event name (`TmuxPaneSnapshot`; do NOT reuse the retired `BackendExecSnapshot`,
whose no-op arm at reducer.ts:6300 must stay). Skip the mint entirely when no
pair matches a NULL-session live job (no event spam; the gate re-fires next pulse).
Reducer: add a fold arm that, for each pair in the frozen event payload, fills
`backend_exec_session_id` on jobs WHERE type='tmux' AND pane_id matches AND
session_id IS NULL — fill-only, NEVER overwrite a non-NULL value (preserves
zellij-parity staleness semantics and makes the fold order-insensitive for
re-fold determinism). The fold reads ONLY the event payload — no probe, no env.
Once filled, the worker-side gate goes false and the poller is quiescent.

Producer-side dedup: track the last posted pairs hash in the restore-worker (like
its existing lastHash pattern) so an unchanged topology doesn't re-post every pulse
while a pane the server can't see keeps a job NULL forever.

COORDINATION: babysit-triage-performance epics are optimizing fold queries in
src/reducer.ts — this task adds one additive arm; rebase/land-order with their
work, do not restructure the dispatch chain.

### Investigation targets

**Required** (read before coding):
- src/restore-worker.ts:1-120 — the data_version pulse loop + lastHash pattern + main messaging
- src/reducer.ts:6270-6320 — the fold dispatch chain; the retired BackendExecSnapshot no-op arm to leave untouched; where the new arm slots
- src/daemon.ts restore-worker onmessage block — where the new {kind} message lands and the synthetic-event mint pattern main uses for other workers (find a sibling: GitSnapshot/UsageSnapshot mints)

**Optional** (reference as needed):
- src/reducer.ts:5984-6011 — the backend_exec COALESCE fold arm (the hook-fed sibling; its comment claiming all coords are hook-stamped needs a one-line rewrite)
- test/reducer-projections.test.ts — projection-fold test shape incl. re-fold determinism assertions

### Risks

- Re-fold determinism is the sacred invariant: the arm must be a pure function of the event payload + prior projection state. Fill-only semantics make replay order-safe; an empty/malformed payload folds to a no-op with the cursor advancing (never throw).
- Event volume: bounded by the gate + dedup hash; worst case (a tmux pane keeper can never resolve, e.g. pane died between hook event and probe) the dedup hash stops re-posting until topology changes.

### Test notes

Worker-side: gate true/false cases, ENOENT skip, dedup hash, message shape — with
injectable spawn, slow-tier. Fold-side: fill-on-NULL, never-overwrite, no-op on
malformed payload, cursor advance, and a cursor=0 re-fold byte-identity case
including a TmuxPaneSnapshot row — extend test/reducer-projections.test.ts.
`bun run test:full` mandatory.

## Acceptance

- [ ] A live tmux job with NULL session (incl. the first-pane-of-human-session case) gets its session name filled within one pulse of the tmux server being probeable; non-NULL values are never overwritten
- [ ] Poller is quiescent when no NULL-session tmux job is live; no event minted when no pair would fill anything; dedup prevents repeat posts on unchanged topology
- [ ] Retired BackendExecSnapshot arm untouched; cursor=0 re-fold byte-identical with the new event in the log
- [ ] `bun run test:full` green

## Done summary

## Evidence
