## Overview

A new `autoclose` daemon worker that automatically closes the tmux -f /dev/null window of DONE
claude agents dispatched by the autopilot or by panels, keyed on the jobs projection
and the autopilot's own readiness verdict. Manual sessions, handoffs, pair partners,
and bus-woken sessions are structurally out of scope: ownership is proven by a new
`jobs.dispatch_origin` column (stamped only when a SessionStart discharges a
`pending_dispatches` row) plus the panels birth-session/name-shape allowlist —
never by tmux heuristics. The end state: a finished `work::`/`close::` worker or a
finished claude panel leg disappears ~30s after it is provably done-and-idle, while
every other window keeps today's stay-open-until-hand-closed behavior. Off-switch:
`autoclose_enabled: false` in `~/.config/keeper/config.yaml` (default ON, 30s grace).
Codex/pi panel legs fire no keeper hooks today, so they are invisible to the jobs
projection and correctly never closed; when a future harness folds them into jobs
they enter the panel bucket with zero autoclose changes.

## Quick commands

- `bun test test/autoclose-worker.test.ts` — the pure decision-core in/out matrix.
- `bun test test/daemon.test.ts test/schema-version.test.ts test/renamer-worker.test.ts` — fleet contract (20 workers), schema whitelist, shared pane-sweep parse stay green.
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT job_id, title, dispatch_origin FROM jobs WHERE dispatch_origin IS NOT NULL LIMIT 5"` — provenance stamps landing (after daemon deploy).
- `rg -n "autoclosed" src/exec-backend.ts src/daemon.ts` — the KillReason value and its single-producer stamp site.

## Acceptance

- [ ] A done-and-idle autopilot-dispatched worker (readiness verdict completed, state stopped) has its tmux window closed after the grace, and the resulting Killed row carries kill_reason 'autoclosed'.
- [ ] A done claude panel leg (stopped past grace) is closed the same way; its answer envelope is intact afterward.
- [ ] A manually-launched claude session, a manual `keeper dispatch` plan worker, a handoff worker, a pair partner, and a bus-woken session are never closed — verified by the pure-core exclusion matrix.
- [ ] `autoclose_enabled: false` (and the string forms false/off/no/0) yields zero kills without a daemon restart; flipping back on resumes without a restart.
- [ ] Autopilot pause suspends the autopilot bucket; the panel bucket is governed only by the config key.
- [ ] Full re-fold reproduces byte-identical `dispatch_origin` values (deterministic-replayed class).
- [ ] The exit-watcher remains the sole Killed producer; autoclose itself writes nothing to keeper.db.
- [ ] `bun run test:full` green.

## Early proof point

Task that proves the approach: `.1` (the discharge-gated provenance stamp). If the stamp
cannot be made both discharge-gated and re-fold deterministic, the ownership scoping has
no airtight discriminator and the design falls back to session-membership + completed-gating
— stop and re-plan before building the worker.

## References

- Prior art and scar tissue: `.keeper/specs/fn-1005-remove-tmux-window-autoclose.md` (end-to-end removal of the old tmux-heuristic reaper), fn-977 (pane-id recycle guard), commit 5b844449 (retry loop interrupted live resumed panes — the reason this design has NO retry loop).
- The old reaper died keying on tmux window heuristics applied to every keeper window; this design keys on the jobs projection + readiness verdict with positive provenance scoping. Do not reintroduce name/bare-shell matching — the terminal ended/killed bare-shell window backlog is an explicit v1 NON-goal.
- Kill primitive semantics: `tmux kill-window -t <paneId>` makes the next liveness probe classify `window_gone_server_alive` (non-restorable close); a pid SIGTERM leaves the trailing login shell holding the pane (`pid_died` — restore loop). Window kill is forced, never process kill.
- Slot-occupancy auto-reclaim (reconcile-core) is complementary: it kills only bare-shell panes for WANTED slots and leaves completed inspection windows; autoclose closes completed windows. An autoclosed worker frees its per-root slot ~grace after done — intended acceleration.
- Known accepted limitations (documented, not bugs): a close worker whose epic ages out of the recent-done window never reaches a completed verdict and its window leaks (hand-close, status quo ante); a bus-woken worker finishing in the agentbus session is outside both buckets and lingers (matches "never close other sessions' agents"); a stale unbound pending_dispatches row could mis-stamp a same-key manual dispatch inside the dispatch TTL (narrow; only a completed worker can ever be closed).

## Docs gaps

- **plugins/plan/skills/panel/SKILL.md**: rewrite the "panel windows stay open for inspection until you close them by hand" claim — done claude legs now auto-close after the grace (gated by autoclose_enabled); codex/pi legs stay open.
- **README.md**: add the autoclose worker to the worker-fleet tour line; document the two config keys with defaults and the exact disable values.

## Best practices

- **Kill by identity tuple, never pane-id alone:** tmux pane ids are per-server-lifetime and reused after destroy; `pane_start_time` is the discriminator that survives reuse [tmux(1), tmux#2849].
- **No retry on a reaper:** a retry against a since-recycled pane id is exactly how the prior incarnation interrupted live sessions; a mismatch is a permanent skip.
- **Fail-closed probes:** any inconclusive tmux/DB probe skips the whole cycle and mints nothing [CWE-367 TOCTOU].
- **Bound the blast radius:** cap kills per pulse so a bad projection state cannot cascade [k8s destructive-automation guidance].
- **Jobs projection is the sole done-authority:** TTY/process state cannot distinguish finished from idle-waiting-input; tmux probes are negative safety gates only.
