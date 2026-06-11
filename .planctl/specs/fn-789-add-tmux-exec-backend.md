## Overview

Add a tmux backend to keeper's exec-backend seam so the autopilot reconciler can
dispatch workers into tmux instead of zellij, selected by a new `exec_backend`
config key (default `zellij` — lands dark; the human flips it manually). The
design is deliberately minimal: session identity comes from launch-time
`-e KEEPER_TMUX_SESSION` env injection for keeper-managed windows plus a
self-gating pane-name snapshot poller (riding the restore-worker's existing
data_version pulse, minting a folded synthetic event) for claudes started in
human-created tmux sessions. NO tmux control-mode client, NO new worker, NO
ingest-time enrichment — those alternatives were investigated and rejected
(see References). As a precursor, both autopilot window reaps and the
`autoclose_windows` system are deleted outright: keeper never closes windows.

## Quick commands

- `bun run test:full` — mandatory gate; this epic touches daemon/worker/db/hook paths
- `KEEPER_CONFIG=/tmp/keeper-tmux-smoke.yaml bun run src/daemon.ts` with `exec_backend: tmux` in the file + a scratch `tmux -L keeper-smoke` server — smoke the dispatch path without touching the real daemon
- `sqlite3 ~/.local/state/keeper/keeper.db "SELECT backend_exec_type, backend_exec_session_id, backend_exec_pane_id FROM jobs ORDER BY last_event_id DESC LIMIT 5"` — verify tmux coords land after the flip
- `tmux list-panes -a -F '#{pane_id} #{session_name} #{pane_dead} #{pane_dead_status}'` — inspect what the poller and remain-on-exit produce

## Acceptance

- [ ] Both window reaps + `autoclose_windows` are gone end to end (code, config parsing, the human's `~/.config/keeper/config.yaml`); `reapSurfaces` no longer exists on `ExecBackend`; keeper never closes a window
- [ ] `exec_backend: tmux` dispatches autopilot workers into a managed tmux session named by the one shared hardcoded `"autopilot"` constant; default config (no key) behaves exactly as today on zellij
- [ ] A claude under tmux stamps `backend_exec_type='tmux'` + pane id from env on every event; managed launches also stamp the session name via `KEEPER_TMUX_SESSION`
- [ ] A claude started in the FIRST pane of a human-created tmux session gets its session name filled by the snapshot poller within one pulse; the poller is quiescent when no NULL-session tmux job is live
- [ ] restore.json buckets carry backend type (RESTORE_SCHEMA_VERSION 2→3) and `restore-agents --apply` routes each bucket through the matching backend; v2 files still restore (read as zellij)
- [ ] No DB SCHEMA_VERSION bump; `keeper/api.py` untouched; a cursor=0 re-fold stays byte-identical including the new snapshot event arm
- [ ] `bun run test:full` green

## Early proof point

Task that proves the approach: `.2` (createTmuxBackend — argv builders + a scratch
`tmux -L` server exercising launch/focus/ensure + remain-on-exit). If the chained
`set-option -p remain-on-exit` form misbehaves outside the verified 3.6b setup:
fall back to setting the window option via a second targeted call keyed on the
`-P -F '#{pane_id}'` return before the command can exit.

## References

- Conversation-locked design (session tmux-session-id-design): control-mode worker + ingest enrichment was fully designed, then REJECTED in favor of this narrow slice — parity with zellij's three values (type/session/pane), nothing more. Control mode remains a future option if polling ever bothers us.
- fn-684 / fn-710 history: keeper already ran an event-bridge feed for zellij (`BackendExecSnapshot`) and tore it out when its consumers (tab namer, reap) died. The retired fold arm at reducer.ts:6300 MUST stay a no-op; the new poller event uses a NEW event name. fn-710's "load-bearing scope boundary" lists exactly the surfaces this epic extends (hook coords, COALESCE fold, restore grouping, focusPane).
- Verified tmux 3.6b experiments (scratch `-L` servers): chained `new-window … \; set-option -p remain-on-exit on` holds dead panes with `pane_dead=1` + `pane_dead_status`; `kill-pane` by id works; explicit `-n` names stick; colons in names break target parsing (always target by pane id); control-mode notifications are server-wide (informed the rejected design).
- practice-scout (community): argv arrays only, never shell strings; `=` exact-match prefix for has-session; trailing-colon `-t 'session:'` target on new-window; `%N`/`@N` ids as the only durable identity; `-e` for process-scoped env (never `set-environment` — visible server-wide); never `.`/`:` in session names.
- Peer coordination: babysit-triage-performance epics own src/reducer.ts fold-query optimization + src/subagent-invocations.ts + plan/transcript-worker re-arm. Task .3 adds ONE additive fold arm to reducer.ts — coordinate landing order with their reducer work; everything else is negotiated disjoint (they avoid exec-backend.ts, autopilot-worker.ts, daemon.ts spawn/ingest blocks).
- Separate window-NAMING system is planned later (not yet an epic); `launch()` keeps its unused `name` arg as that seam; managed windows stay unnamed here.

## Docs gaps

- **README.md**: config section (~305-343) — delete `zellij_session`/`autoclose_windows` docs, add `exec_backend`; ExecBackend prose (~2167-2219) — "Zellij is the only backend" + the reap paragraph are false post-epic; restore prose (~2229-2277) — per-bucket backend type; hook env table (~53-60, 1678-1702) — add the tmux row, drop "currently the only recognized backend"
- **docs/exec-backend.md**: lead + factory example expand to two backends; prune the reapSurfaces sections; collapse the "Extending to a new backend" how-to now that the second backend exists; update DEFAULT_* constants
- **CLAUDE.md**: hook scraping fence gains TMUX/TMUX_PANE/KEEPER_TMUX_SESSION (in-scope for task .2)

## Best practices

- **Argv arrays everywhere:** every tmux invocation is `spawn(["tmux", ...])` — no shell strings; session/window names and worker argv never pass through a shell layer [qwen-code production pattern]
- **Ids over names:** `%pane_id`/`@window_id` are the only durable handles; numeric indices shift, names glob-match (`fnmatch`) unless `=`-prefixed [tmux wiki]
- **`-e` for env, not `set-environment`:** process-scoped injection; the tmux global/session env is readable by every attached client [tmux man]
- **Replace, don't delete, retired fold arms:** historical events in the immutable log must fold to explicit no-ops or re-fold diverges [fn-710, CLAUDE.md re-fold invariant]
