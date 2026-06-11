## Description

**Size:** S
**Files:** src/transcript-worker.ts, test/transcript-worker.test.ts, README.md

### Approach

The transcript-worker has ONE static @parcel/watcher subscription on
~/.claude/projects (set in main() at ~:1031-1095, stored in a single
`subscription` variable at :1082) and NO reconcile loop — so the re-arm is a
net-new minimal replace primitive driven directly from the 60s heartbeat,
which is the sanctioned subscription-replace shape (not process self-heal).
When the heartbeat's existing `rescued = scanJobsForTitles(db, stream)`
returns true: (1) check a generation/active flag so a stale in-flight
callback batch (which can fire AFTER unsubscribe resolves) can't touch
torn-down state or double-fire the re-arm; (2) `stat()` the watch root first
— if ~/.claude/projects is missing (or the re-arm is under
`disableNativeWatcher`), defer: log and retry on the next heartbeat, never
error; (3) sequentially `await subscription.unsubscribe()` THEN
`watcher.subscribe(watchRoot, ...)` with the IDENTICAL options (deliberately
NO ignore globs — negated extglobs trip parcel-bundler/watcher #174); (4) run
one full `scanJobsForTitles` pass after the fresh subscribe (APFS coalescing
means never back-fill); (5) flap guard: arm at most one replace per heartbeat
interval and reset the guard only after the new subscription survives a full
interval without a rescue. Re-subscribe failure is NON-fatal — log and leave
unwatched until the next heartbeat re-fires — explicitly diverging from the
boot subscribe's fatal `.catch` (closeDb + process.exit at ~:1096-1102),
because re-arm is recovery, not boot. The replace must leave the `stream`
object and its byte offsets untouched (scanJobsForTitles uses a transient
decoder precisely to avoid re-anchoring — ~:766, :881); only the
`subscription` variable is swapped. Never call process.exit on the recovery
path; teardown is try/caught best-effort like shutdown's.

Extract the re-arm decision (rescued + flap-guard state + root-stat result ->
replace now / defer / skip) as a PURE exported helper and unit-test it in
test/transcript-worker.test.ts. Log each re-arm fire with a
`[transcript-worker]` stderr line, and log the watcher callback `err`
argument when present. Update the README transcript-worker recovery paragraph
(parallel structure with the plan-worker paragraph from task .1), present
tense.

### Investigation targets

**Required** (read before coding):
- src/transcript-worker.ts:1031-1102 — the boot subscribe, the single subscription variable, the fatal .catch the re-arm must NOT mirror
- src/transcript-worker.ts:915-955 — the heartbeat: where rescued comes from and where the replace hooks in
- src/transcript-worker.ts:766, 881-902 — the transient-decoder/byte-offset invariant the replace must preserve, and the distinct rescan-drop path (do not conflate)
- src/transcript-worker.ts:980-1024 — shutdown teardown (the try/catch hygiene to mirror) + the disableNativeWatcher seam and missing-root guard

**Optional** (reference as needed):
- src/git-worker.ts:2256-2284 — tearDownForResubscribe: the NOT-a-drop teardown ethos being mirrored in miniature
- test/git-worker.test.ts:2389-2405 — the pure decision-helper test pattern

### Risks

The heartbeat directly driving the replace (no reconcile loop) is the
riskiest divergence from the precedent — the generation flag and the
one-replace-per-interval flap guard are what keep it from becoming a spin
loop if the replacement stream is also mute. Keep both.

### Test notes

Pure unit tests on the decision helper: rescue+healthy-guard -> replace;
rescue during unexpired guard -> skip; missing root -> defer; shutting-down ->
skip. `bun run test:full` mandatory.

## Acceptance

- [ ] A transcript-heartbeat rescue replaces the single subscription sequentially (unsubscribe completes before subscribe), identical options, full scan after
- [ ] Stale in-flight callbacks after teardown are inert (generation flag); at most one replace per heartbeat interval
- [ ] Missing watch root defers the re-arm without error; re-subscribe failure is non-fatal and retries next heartbeat
- [ ] stream byte offsets untouched across a replace (no re-anchoring, no phantom re-folds)
- [ ] Pure exported decision helper with unit tests; README transcript paragraph updated
- [ ] `bun run test:full` green

## Done summary
Transcript-worker now re-arms a silently-mute FSEvents subscription directly from its 60s heartbeat: a pure decideTranscriptResubscribe helper gates a sequential unsubscribe->subscribe replace (identical options, generation-guarded callbacks, stat-before-resubscribe defer, non-fatal failure, one-heartbeat flap guard), leaving the line stream's byte offsets untouched so no phantom re-folds. README scopes the dropped-events path and names the transcript recovery path in parallel with plan-worker.
## Evidence
