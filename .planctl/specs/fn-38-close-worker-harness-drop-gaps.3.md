## Description

**Size:** M
**Target repo:** /Users/mike/code/keeper
**Files:** src/exit-watcher.ts, src/reducer.ts, src/readiness.ts, src/autopilot-worker.ts (+ tests) — exact surface depends on the approach decision below

Closes F5 from task .3's silent-death census. PARENT_SESSION_TEARDOWN is the
costliest terminal class (7/82 deaths, all terminal work-loss): the
orchestrator `/plan:work` session ends (`SessionEnd` within 0-3s of the
worker death) while a worker subagent is in flight, and the worker dies with
it unrecovered. Both sampled cases (sids 9687dcdd, c81bf8fe) were
**autopilot-dispatched** `work::fn-...` sessions, so keeper's autopilot
reconciler — which runs in keeperd independent of any orchestrator session —
is the natural resumer.

### Approach

**Primary (recommended): detect-and-re-dispatch at keeper.** When a worker
job's parent session emits `SessionEnd` with that worker's turn still open
(no terminal text, no `done`), treat it as a teardown-orphan: mint the same
synthetic drop signal as .2's detector and let autopilot re-dispatch the
ready task. This keeps the fix entirely keeper-side and reuses .2's resume
path. **Open approach decision** — the alternative is an orchestrator-side
drain/checkpoint guard that flushes in-flight workers *before* `SessionEnd`;
it prevents the loss rather than recovering from it, but lives in the
work-skill/harness surface (cross-repo, harder) and cannot help a hard
session kill. Default to detect-and-re-dispatch unless the worker/planner
finds autopilot cannot safely own re-dispatch for human-orchestrated (non
-autopilot) sessions, where only a drain guard would help.

This task depends conceptually on .2's synthetic-drop-signal plumbing; if .2
lands first, reuse its mint+resume path rather than duplicating it.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts (SessionEnd fold + the running-rows sweep ~:3751-3802) — where a parent SessionEnd meets an open worker turn
- src/exit-watcher.ts — the synthetic-event mint path (shared with .2)
- src/autopilot-worker.ts (reconcile ~:813, buildWorkerCommand ~:249) — how autopilot re-dispatches a ready task, and the dispatch-key/cooldown rules a re-dispatch must respect
- CLAUDE.md "Autopilot" + "Event-sourcing invariants" sections

**Optional** (reference as needed):
- task .3 evidence sids: 9687dcdd (SessionEnd@+3s), c81bf8fe (SessionEnd@+1s) — both autopilot-dispatched; representative teardown signatures

### Risks

- Distinguishing a teardown-orphan from a normal end-of-session (worker already done/returned) — the open-turn + no-terminal-text guard is load-bearing, same as .2.
- Re-dispatch must respect the autopilot cooldown / dispatch-key rules so a teardown-orphan does not thrash against an already-requeued task.
- Human-orchestrated (non-autopilot) sessions have no server-side resumer; the approach decision must state what happens to those (recover via autopilot only, or accept they need the drain-guard alternative).

### Test notes

`bun run test:full` mandatory (reducer / autopilot / exit-watcher paths). Fixture the teardown signature from the .3 evidence sids; assert no re-dispatch when the worker had already returned terminal text before its parent's SessionEnd.

## Acceptance

- [ ] A parent SessionEnd landing on an in-flight worker turn (open turn, no terminal text, no done) is recognized as a teardown-orphan and routed to recovery (autopilot re-dispatch via the synthetic drop signal), so PARENT_SESSION_TEARDOWN stops causing terminal work-loss.
- [ ] The approach decision (detect-and-re-dispatch vs. orchestrator drain guard, incl. the non-autopilot-session case) is resolved and recorded in the Done summary with rationale.
- [ ] No re-dispatch when the worker returned terminal text before its parent's SessionEnd, proven by a fixture + negative control; re-fold determinism preserved.
- [ ] `bun run test:full` green; work committed via `keeper commit-work`.

## Done summary

## Evidence
