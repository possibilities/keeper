## Description

**Size:** S
**Files:** src/commit-work/attribution.ts, cli/commit-work.ts (+ tests). The
daemon-RPC variant (only if read-side-wait is rejected) would add
src/server-worker.ts, src/rpc-handlers.ts, a synthetic event type, and a
worker→main bridge — see Approach.

### Approach

Make `keeper commit-work` read a CONSISTENT `(file_attributions, live-dirty)`
set, closing the poll-lag window that task `.1` (poll-only git producer) leaves.

THE PROBLEM: `file_attributions` — the files a session is on-the-hook for — is
charged ONLY in pass 1 of the GitSnapshot fold (`reducer.ts:1041-1352`,
`buildExplicitAttribHoist`), by intersecting the promoted `mutation_path` events
with the GitSnapshot's live-dirty set. `commit-work` reads that projection
(`src/commit-work/attribution.ts`: undischarged `file_attributions` ∩ a LIVE
`git status`) to decide what to stage. With the `.1` poll producer scanning
every ~300ms, a file edited immediately before commit-work runs is live-dirty
but NOT yet charged (no GitSnapshot since the edit) → commit-work could miss
staging it.

PRIMARY APPROACH — read-side wait, in-scope to commit-work (NO new RPC surface):
before computing the on-hook set, commit-work checks whether its session's
latest mutations are reflected in `file_attributions` (e.g. every live-dirty
session-file has a charged row, or `file_attributions.last_mutation_at` covers
the session's latest `mutation_path` event id). If not, WAIT — poll keeper.db
read-only — until the `.1` poll producer scans + folds a GitSnapshot covering
the edit, then read. The wait MUST be bounded and FAIL-OPEN: a ~1–2s ceiling →
fall back to the current read (commit-work never hangs on a wedged producer).
This rides `.1`'s ~300ms scan cadence, needs no daemon RPC, no new synthetic
event, no guarded-surface change, and keeps commit-work's existing
live-`git status` read intact.

ALTERNATIVE (only if read-side wait proves insufficient — e.g. the ~300ms tail
is unacceptable): a sanctioned scan-now TRIGGER. DESIGN FORK to resolve first:
is the trigger a 6th guarded mutating-RPC verb (CLAUDE.md "RPC writes only 5
surfaces" — a real invariant change), OR does it ride a NON-mutating producer
signal (a "kick the git-worker to scan this root now" channel, like the existing
`data_version` wake — NOT a projection write, so not a 6th guarded surface)?
Strongly prefer the non-mutating kick if a trigger is needed at all. Do not add
a guarded RPC verb without an explicit planning decision.

### Investigation targets

**Required** (read before coding):
- src/commit-work/attribution.ts:1-90 — `getSessionDirtyFiles` / `discoverSessionFiles` (undischarged `file_attributions` ∩ live `git status`); where the read-side wait goes
- cli/commit-work.ts — the commit-work entry that calls `discoverSessionFiles` (the wait wraps this read)
- src/reducer.ts:1041-1352 — `buildExplicitAttribHoist` (how/when `file_attributions` is charged — the cadence the wait keys off)
- src/git-worker.ts (task `.1`'s poll producer) — the scan cadence the wait relies on; read after `.1` lands

**Optional** (only for the RPC/kick alternative):
- src/server-worker.ts, src/rpc-handlers.ts — the guarded RPC surface (5-verb limit) the trigger would touch
- src/wake-worker.ts — the `data_version` non-mutating wake pattern (the model for a non-guarded kick)

### Risks

- **Never hang commit-work:** the wait MUST be bounded + fail-open to the current behavior — a wedged/slow producer can't block a commit.
- **Do not add a 6th guarded RPC surface casually:** the read-side wait avoids it entirely; the trigger alternative needs an explicit decision (prefer the non-mutating kick).
- **Consistency definition:** the "is my session caught up" check must be correct (a live-dirty session-file with no charged row = not yet folded) and must not false-wait forever on a file that legitimately won't charge (e.g. an excluded/`.keeper` path).

### Test notes

- Unit-test the "is the session's attribution caught up?" predicate with synthetic `file_attributions` + mutation rows (in-process `freshDb()`); cover the fail-open timeout path. `bun run test:full`.

## Acceptance

- [ ] `keeper commit-work` reads a consistent `(file_attributions, live-dirty)` set — a file edited immediately before commit-work is attributed + staged
- [ ] the wait is bounded + fail-open (a wedged/slow git producer never hangs commit-work; it falls back to the current read)
- [ ] no new guarded mutating-RPC surface added (read-side wait), OR an explicit planning decision recorded if a non-mutating kick is used
- [ ] `bun run test:full` green

## Done summary

## Evidence
