## Description

**Size:** S
**Files:** src/plan-worker.ts, test/plan-worker.test.ts, README.md

### Approach

Reorder `PlanScanner.onChange` so the cheap in-memory change-gate runs BEFORE the
fn-629 in-HEAD probe, eliminating the per-scan `git cat-file -e` fork for every
unchanged file (~99% of ~1.7M forks/day; the starved 5s heartbeat and the 50%
rescue rate at ~227s staleness in backstop.ndjson are the live symptoms).

The exact final ordering (load-bearing — this IS the task):
1. parse -> build msg -> existing null-check.
2. `serialized = JSON.stringify(msg)`; if `this.lastEmitted.get(msg.id) === serialized`:
   `this.pathToId.set(path, msg.id)` then `return false`. No probe, no pending
   mutation. (pathToId.set is required on this branch: boot seeds `lastEmitted`
   from the projection but not `pathToId`, and delete-tombstone routing needs the
   mapping. Do NOT call deletePending here — fail-closed; an unchanged path
   cannot legitimately be pending because the fn-629 gate means an uncommitted
   path never earned a lastEmitted entry.)
3. Otherwise (changed or first-seen): run the fn-629 probe EXACTLY as today —
   `if (!triggeredByCommit && !this.isTracked(path))` -> log the gate bounce,
   `addPending(path)`, `return false`, touching NEITHER `pathToId` NOR
   `lastEmitted` (the doc block at plan-worker.ts:1447-1469 stays true verbatim).
4. Probe passed: `deletePending(path)`, `pathToId.set`, `lastEmitted.set`,
   `onSnapshot(msg)`, `return true` — as today.

Invariants that must hold untouched: the `triggeredByCommit` bypass still skips
the probe AND still flows through the change-gate (a commit re-ingest of an
unchanged file suppresses cheaply); `recheckPending`'s batched drain (which calls
onChange per in-HEAD path) still emits; the `markSeen` census in scanPlanctlDir
pass 2 is NOT touched (the reorder lives entirely inside onChange) so the
ghost-retraction sweep keeps a complete census; fn-720 rescued accounting is
derived from emitted booleans and is unchanged.

Document the one accepted semantic shift as a code comment: in-HEAD-ness is
re-verified only when content changes; an unchanged file's HEAD-membership
regression (e.g. branch switch) has no observable effect because the change-gate
suppresses re-emits regardless. Out of scope (do not gold-plate): batching the
residual probes via isPathInHeadBatch inside scanPlanctlDir — the reorder alone
delivers the win.

Update README.md ~1222-1235 (fn-629 gate prose) to describe change-gate-first.

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:1441-1492 — onChange: current probe-then-gate ordering, the doc block, the bookkeeping rules
- src/plan-worker.ts:1530-1600 — recheckPending: the batched fail-closed drain that must keep working
- src/plan-worker.ts:2285-2316 — scanPlanctlDir pass 2: markSeen census + per-file onChange (do not touch census)
- test/plan-worker.test.ts:304-345 — existing change-gate test shape; :1679 — gated-path pin (untracked -> pending, no emit)

**Optional** (reference as needed):
- src/plan-worker.ts:1908-1930, 1958-2000 — isPathInHead / isPathInHeadBatch (residual probe primitives; batch is out of scope)
- .planctl/specs/fn-629-*.md, fn-712-*.md — gate semantics history

### Risks

- fn-627/fn-629 regression: advancing `lastEmitted` before the probe for a
  changed-but-uncommitted file would make the post-commit drain see "unchanged"
  and never emit — the epic sits projection-absent forever. The ordering above
  prevents this; the spy tests pin it.
- Boot-seed asymmetry: lastEmitted seeded from DB, pathToId empty — the
  unchanged-branch pathToId.set is the guard against ghost rows on delete.

### Test notes

PlanScanner takes an injectable `isTracked` (3rd ctor arg) — spy on it. New cases:
(a) unchanged re-scan: isTracked NOT called, no emit; (b) first-seen uncommitted:
isTracked called, lands pending, lastEmitted untouched; (c) changed committed:
isTracked called once, emits; (d) pending file drains via recheckPending after
commit (existing :1679 pin stays green); (e) boot-seed: seeded lastEmitted + empty
pathToId -> unchanged scan -> file delete -> tombstone still emitted.

## Acceptance

- [ ] unchanged re-scans call `isTracked` zero times (spy test) and emit nothing
- [ ] gated paths still never touch `lastEmitted`/`pathToId`; pending drains still emit after commit (existing pins green)
- [ ] markSeen census and fn-720 rescued accounting are byte-untouched by the diff
- [ ] README fn-629 prose updated to change-gate-first
- [ ] full `bun test` green

## Done summary
Reordered PlanScanner.onChange so the in-memory change-gate runs before the fn-629 in-HEAD probe: unchanged re-scans suppress with zero git cat-file forks, eliminating the per-scan subprocess storm. Gate semantics preserved (gated paths never earn lastEmitted; unchanged branch sets pathToId to route boot-seed delete tombstones). Added 4 spy-on-isTracked tests; README fn-629 prose updated to change-gate-first.
## Evidence
