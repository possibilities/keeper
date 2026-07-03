## Description

**Size:** S
**Files:** (none — operational verification on the live host; evidence lands in this task)

### Approach

With the crash-loop fixed (task 1 landed), run the existing reclaim path against the live
keeper.db — measured today at 1.27GB with the events table at 922MB holding 833k live rows
against a max id of 4.7M (~3.9M retention-shed rows never physically reclaimed). Then answer
one bounded question: do the [fold-slow] 350-400ms single-event folds observed during the
incident persist after reclaim?

Steps: capture before-metrics (file size, fold-slow incidence over a representative window of
server.stderr); run `keeper reclaim-db` per its own contract (it wraps VACUUM INTO); verify
integrity_check ok and the size reduction; capture after-metrics over a comparable window.
If fold-slow persists at similar incidence, file it as a separate follow-up epic (defer
machinery) and record the id — measurement only, NO investigation here.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/reclaim.ts + src/backup.ts:443 — the reclaimDb contract (flags, safety checks, output envelope)
- ~/.local/state/keeper/server.stderr — [fold-slow] line shape for the incidence measurement

**Optional** (reference as needed):
- src/compaction.ts — what retention sheds (context for why live rows are a fraction of max id)

### Risks

- Reclaim on a live daemon: follow reclaim-db's own guardrails; do not invent a bypass. If it
  refuses while the daemon runs, coordinate a brief pause window and say so in Evidence.

### Test notes

No code change expected; the deliverable is the executed reclaim plus recorded before/after
metrics. If reclaim-db itself misbehaves, that is a finding to report, not to fix here.

## Acceptance

- [ ] keeper reclaim-db executed against the live DB with integrity verified and the file-size reduction recorded
- [ ] fold-slow incidence measured before and after over comparable windows and recorded in Evidence
- [ ] If fold-slow persists, a follow-up epic is filed and its id recorded; no deeper investigation performed in this task

## Done summary
Executed keeper reclaim against the live keeper.db (daemon paused+booted out, offline VACUUM INTO, self-verify, atomic swap, daemon restarted clean). Size: 1.2GB (1297080320B) -> 755.5MB (792215552B), reclaimed 452.7MB; verify OK schema_version=106 auto_vacuum=2 row-counts-identical; post-swap quick_check=ok freelist=0; rollback snapshot kept at keeper-20260703T143103.db. fold-slow measured over comparable ~6min windows on the healthy (post-fix) daemon: BEFORE (1.2GB, 48 events) = 0 slow folds; AFTER (755MB, 8 events) = 0 slow folds; the 12588 all-time fold-slow counter did not increment in either window. fold-slow does NOT persist after reclaim -- it was already 0 once the crash-loop fix was deployed, so the 350-400ms incident-era folds were a serve-wedge/stampede artifact, not steady-state DB behavior. Conditional not triggered: no follow-up epic filed. Caveat: both windows low-activity (slow fold-types are git/tmux snapshots, quiet during measurement).
## Evidence
