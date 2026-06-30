## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/reducer.ts and/or a live-only projection + src/collections.ts, src/readiness-client.ts, plus tests

Build a durable, subscribable signal for "epic <id>'s lane branch is merged
into the default branch." None exists today: finalize success/in-flight/
transient-skip mint nothing (only a `console.error` at
`src/autopilot-worker.ts:2643`); only genuine failures write
`dispatch_failures` rows; and the merge-state computation
(`mergeLaneBaseIntoDefault`/`gitIsAncestorOf`) is ephemeral.

### Approach

The seam is fn-1014's `computeDeferredEpicIds` (`src/autopilot-worker.ts:1877-1916`
doc / `:1917+` impl), which ALREADY probes "lane A is an ancestor of the local
default branch" git-side every reconcile cycle. The probe result is the raw
material; the work is making it durably observable WITHOUT violating the
invariants. Two candidate shapes — pick one and justify in Done summary:
(a) a synthetic producer-minted event (e.g. `LaneMerged`) folded
DETERMINISTICALLY off `event.ts` into a deterministic-replayed projection — the
producer (which may touch git) mints the event, the fold never touches git/
wall-clock/fs; or (b) a LIVE-ONLY projection recomputed each cycle from the DAG
+ live git (like the worktree lane derivation), rewound via `rewindLiveProjection`,
never `DELETE`, bounded if unbounded. Per CLAUDE.md: never read git/wall-clock/
env/fs inside a fold (only producers probe those); a fold whose cost grows with
history/board size is a re-fold time-bomb (bound it). Surface the resulting
"merged-to-default" set/flag on `ReadinessClientSnapshot` (building on the core
epic's snapshot-extension pattern) so `landed` and `keeper status` can read it.

### Investigation targets

**Required** (read before coding):
- src/autopilot-worker.ts:1877-1916 (`computeDeferredEpicIds` probe), :2606-2802 (`finalizeEpic` / `mergeLaneBaseIntoDefault`), :2643 (the silent transient-skip console.error)
- CLAUDE.md "Event-sourcing invariants" + "Never wipe-and-replay the live-only projections" + "A fold whose per-event cost grows…" — the hard constraints
- src/collections.ts — collection-descriptor + `recencyBound` pattern for a new subscribable surface
- src/readiness-client.ts:1727-1739 — the snapshot construction site (where the merged signal is surfaced, alongside the core epic's autopilot fields)
- src/reducer.ts — synthetic-event fold dispatch (if shape (a)) — NOTE: readiness.ts/reducer.ts may contain NUL bytes; use `rg`/`grep -a`

### Risks

- This is the highest-risk task in the plan: the durable observable must NOT become a fold that touches git/wall-clock (re-fold determinism is sacred). If shape (a) can't be made deterministic, shape (b) live-only is the fallback — decide early.
- Worktree mode OFF: there are no lanes, so "merged-to-default" is vacuously true once the epic is done — the signal must degrade cleanly so `landed` == `complete` in that mode.

### Test notes

Pure fixtures over the chosen projection/fold (no real git): assert the merged signal appears for a merged lane and not for an unmerged-but-done epic; assert re-fold determinism if shape (a) (replay twice → identical). Sandbox all six state classes; `retryUntil` not sleep.

## Acceptance

- [ ] A durable, subscribable "epic lane merged to default" signal exists and is surfaced on `ReadinessClientSnapshot`.
- [ ] No git/wall-clock/fs read inside any fold; if live-only, rewound via `rewindLiveProjection` (never DELETE) and bounded.
- [ ] Worktree mode OFF degrades cleanly (merged ⇔ done).
- [ ] Pure fixture tests (incl. re-fold determinism if event-sourced); `bun test` green.

## Done summary

## Evidence
