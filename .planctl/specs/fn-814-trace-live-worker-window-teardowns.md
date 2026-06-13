## Overview

A small but costly harness-drop class (PARENT_SESSION_TEARDOWN — 7 deaths in
the fn-37 silent-death census, all terminal work-loss) happens when an
autopilot-dispatched `/plan:work` orchestrator session ends while its worker
subagent is still mid-tool-call: the worker dies with the parent process,
unrecovered. Both sampled cases (sids 9687dcdd 2026-06-08, c81bf8fe
2026-05-29) show the worker actively running Read/Bash 3-14s before the
parent's `SessionEnd`, and a third session (4f59f656) died within 2s of
9687dcdd — a near-simultaneous multi-session teardown, not a human closing one
window.

The teardown signature is `SessionEnd reason=other`, which is NOT a
user-initiated exit (`prompt_input_exit`) — it is an external process
termination (window/pane killed, SIGHUP/SIGTERM, crash, sleep). Crucially,
`reason=other` is also how ~93% of ALL sessions end (3,239/3,475), i.e. the
normal teardown of autopilot tmux windows — so the phenomenon is a normal
window teardown occasionally racing a live worker, not a distinct error path.

This epic does NOT fix anything blind. The governing principle: if we cannot
attribute what kills the tab, we add tracing rather than guess at a fix. The
deliverable is attribution — which mechanism tears down mid-worker windows —
and a recommendation that is EITHER a targeted guard (if the cause is
keeper-owned and preventable) OR the minimal durable tracing to make future
mid-worker teardowns attributable. Recovery (re-dispatch of orphaned tasks) is
tracked separately and is not in scope here.

## Quick commands

- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT json_extract(COALESCE(e.data,b.data),'$.reason') reason, COUNT(*) FROM events e LEFT JOIN event_blobs b ON b.event_id=e.id WHERE hook_event='SessionEnd' GROUP BY reason"` — reason distribution (other dominates)
- `git -C /Users/mike/code/keeper log --oneline -- src/reaper-worker.ts` — the fn-802 window-reaper history (created 2026-06-11)

## Acceptance

- [ ] The teardown source(s) for mid-worker window deaths are attributed with evidence, OR ruled unattributable from existing data with every checked surface listed.
- [ ] The fn-802 tmux reaper is explicitly cleared or implicated: confirm whether its `stopped` + perTask `{tag:"completed"}` gate can ever fire on a window whose worker subagent still has an open turn (it landed 2026-06-11, AFTER both sampled deaths, so it cannot be the historical cause — but it is the prime new-surface suspect for any post-2026-06-11 case).
- [ ] A recommendation is produced and recorded: a targeted guard if the cause is keeper-owned and preventable (e.g. do not reap/teardown a window whose worker has an open turn), or the minimal durable tracing if unattributable (the reaper already writes a stderr audit line — evaluate making reap-kills a queryable signal). No blind fix is applied in this epic.

## Early proof point

Task that proves the approach: ordinal 1 — re-scan the census for any
post-2026-06-11 mid-worker teardown. If one exists and correlates with a
reaper audit line, the new reaper is implicated and attribution is immediate;
if none exist, the class is pre-reaper and attention shifts to the prior
~60-80s teardown mechanism and external causes (sleep, the since-removed
zellij backend).

## References

- src/reaper-worker.ts — the fn-802 window-reaper; kill gate at selectReapCandidates (:143), `tmux kill-window` via src/exec-backend.ts:338; created 2026-06-11 (commit 63fd6e92), prior ~60-80s mechanism per commit 80e3dbb7
- src/exit-watcher.ts — dead-pid reprobe that mints synthetic Killed ~60s later (the slow backstop that produced the 02:31 Killed for 9687dcdd)
- src/readiness.ts (computeReadiness) — the perTask `{tag:"completed"}` verdict the reaper gates on
- keeper setup-tmux / dash rebuild path (recent commit 15dfa754 `=dash:` window targets) — a window-rebuild teardown surface to rule in or out
- fn-37 (planctl repo) task .3 done summary — the silent-death census this epic follows from; sample sids 9687dcdd, c81bf8fe, plus 4f59f656

## Out of scope

- Recovery / re-dispatch of teardown-orphaned tasks (the "what to do after a drop" lever) — tracked separately; this epic is attribution + prevention/tracing only.
- Any fix applied without first attributing the cause — explicitly forbidden by the epic's governing principle.
