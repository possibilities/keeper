## Description

**Size:** M
**Files:** src/git-worker.ts, src/autopilot-worker.ts, src/daemon.ts, src/reducer.ts, test/git-worker.test.ts, test/git-live-projection.test.ts

### Approach

Close the retirement deadlock for watched-and-vanished lane roots,
producer-side, keeping the GitRootDropped tombstone → retractGitStatus
fold as the SOLE retire path. (1) Sweep fix: `selectVanishedRoots`
(or its caller) also returns currently-watched roots whose directory
is provably gone — the discriminator treats ONLY ENOENT/ENOTDIR as
vanished (a stat probe, not bare existsSync); any other error fails
closed and keeps the root. Require the vanished verdict on two
consecutive sweep passes before retiring a currently-watched root
(debounce protecting live lanes from transient blips); unwatched
roots keep today's behavior. Retiring a watched root also cleans its
subscription and scheduler state — exactly ONE tombstone posts per
retire (refactor the unsubscribe primitive if needed so cleanup and
tombstone-post do not double-fire; keep threading vanishedTombstoned,
and prune its entries once the tombstone round-trips so the set stays
bounded). Boot behavior (empty watched set) must be byte-identical.
(2) Teardown nudge: both teardown sites — finalize and recover
pass-3 — post a payload-free nudge to main after their removals
complete, relayed to the git-worker mirroring the existing
nudge-discovery relay; the nudge only schedules an immediate
vanished-sweep pass (with the same debounce satisfied by two
immediate consecutive probes or an equivalent guard the worker
designs — the ENOENT gate re-verifies at retire time regardless).
A deferred or failed removal (retry-skip, backup-failed,
remove-failed branches) must NOT nudge-and-retire the still-present
path; scope the nudge to completed-removal exits. The nudge carries
no path — the sweep keys on git_status.project_dir rows, which are
canonical by construction, so lane-path canonicalization mismatches
cannot no-op the delete. (3) Fold check: verify a watched, snapshotted
lane always carries a numeric attribution_event_id so the retract's
DELETE is reachable; if a null-attribution phantom row can skip the
DELETE via the prior-floor early return, reorder so the row DELETE
happens for the null case too. (4) Sequencing: removals complete
before the nudge posts; snapshots and tombstones travel the same
git-worker→main channel — verify that single-channel ordering makes
post-tombstone snapshot resurrection impossible, and state the
finding in the test that covers it.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/git-worker.ts:1376-1394 — selectVanishedRoots (the skip at :1388 is the deadlock half); :607 the .keeper always-watched short-circuit; :2511-2606 the sweep call site, dwell drop, and clean re-check; :2445-2478 unsubscribeRoot (posts its own tombstone — the double-post hazard); :2526 vanishedTombstoned; :352 FULL_SWEEP_INTERVAL_MS
- src/git-worker.ts:85-92, :175-183 — GitWorkerInbound union + GitRootDroppedMessage (attribution_event_id null = vanished/no-observation)
- src/daemon.ts:10048-10059 — the nudge-discovery relay precedent; :10423-10430 the git-root-dropped handler
- src/autopilot-worker.ts:6143-6172 — finalize teardown exits (expectedBranchByPath retry-skip must not nudge); :8053-8147 recover pass-3 exits (dirty force-remove at :8107 is the #40 reproducer; backup-failed :8118 / remove-failed :8128 must not nudge)
- src/reducer.ts:2732-2835 — retractGitStatus (floor gate :2736, prior-floor early return :2744 vs the row DELETE :2835 — the null-attribution reachability check); :2168-2195 readRootAttributionFloor; :2601 projectGitStatus re-upsert (why producer-side sequencing is the resurrection guard)
- test/git-worker.test.ts:1947-1985 — the four selectVanishedRoots tests; :1973 currently encodes the bug and must invert

**Optional** (reference as needed):
- test/git-live-projection.test.ts:247-265 — GitRootDropped fold tests + test/helpers/git-event-payload.ts builder
- src/autopilot-worker.ts:658-675 — normalizeLanePath raw-on-absent fallback (why the nudge carries no path)

### Risks

- The debounce must not make the boot path or unwatched-root retire slower or behaviorally different — scope it to currently-watched roots only.
- Reusing unsubscribeRoot verbatim double-posts tombstones; not cleaning subscription/scheduler state leaks pollers on a dead dir. The refactor must land exactly one of each effect per retire.
- The recover pass-3 force-remove of a DIRTY lane is the witnessed reproducer — cover it explicitly in tests, not only the clean finalize path.
- A nudge landing mid-sweep must coalesce, not re-enter the sweep concurrently.

### Test notes

Pure seams only (injected probe/exists fns, no real git/daemon).
Red-repro first: a currently-watched root whose probe yields ENOENT on
two consecutive passes retires (unsubscribed + one tombstone); the same
root with EIO stays; a single-pass ENOENT stays (debounce); boot-shape
(empty watched set) matches today's goldens. Fold side: GitRootDropped
with null attribution deletes a phantom row that has no prior floor.
Nudge side: completed-removal exits post the nudge, deferred/failed
exits do not. Reconcile all four selectVanishedRoots tests. Named
gates: `bun test ./test/git-worker.test.ts ./test/git-live-projection.test.ts`
plus `bun run typecheck`.

## Acceptance

- [ ] A currently-watched root whose directory is gone (ENOENT/ENOTDIR on two consecutive sweep passes) is retired: subscription and scheduler state cleaned, exactly one GitRootDropped tombstone posted with null attribution, and the git_status row deleted.
- [ ] Any other probe error, or a single-pass ENOENT, retires nothing — deterministic tests prove the fail-closed and debounce behavior, and the boot path is unchanged.
- [ ] Both teardown sites nudge an immediate vanished-sweep pass only on completed removals; deferred/failed removal branches never nudge; the nudge carries no path and mints no second retire path.
- [ ] A phantom row carrying null attribution_event_id is still deleted by the retract fold; post-tombstone snapshot resurrection is shown impossible under the single-channel ordering, with the assumption asserted in a test.
- [ ] The bug-encoding vanished-sweep test is inverted and all sibling tests reconciled; focused named gates plus typecheck are green.

## Done summary
Retire torn-down watched lane git rows producer-side: selectVanishedRoots now retires currently-watched-and-gone roots behind an ENOENT/ENOTDIR-only, fail-closed, two-pass-debounced stat discriminator with exactly one tombstone per retire, and both teardown sites nudge an immediate vanished sweep on completed removals only. Verified the retract fold's null-attribution DELETE is already reachable (no reducer reorder), covered by fold + resurrection-safety tests.
## Evidence
