## Overview

Make keeperd a persistent tmux control-mode client (`tmux -C`) that observes, in
real-time, which session/window/pane the current attached tmux client is focused on,
folds it into a new live-only singleton projection, and renders it on the `keeper jobs`
banner. v1 is FOCUS-ONLY — subsuming the existing ~1s tmux topology poll onto this same
control client is a deliberate phase-2 epic, planned after this lands. The design is the
product of deep investigation + two judged design panels and was verified against the
codebase by the planning scouts.

## Quick commands

- `keeper jobs` — then switch tmux windows/sessions in another pane; the `[focus <session>:<win> %<pane>]` banner updates within a beat.
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT status,session_name,window_index,pane_id,generation_id FROM tmux_client_focus"` — inspect the live singleton.
- `bun run test:full` — mandatory (touches daemon/worker/db/reducer/compaction).

## Acceptance

- [ ] keeperd holds ONE persistent `tmux -C` control client, attached with `-N` (never starts a server), `-f no-output,ignore-size,no-detach-on-destroy`, `no-output` set exactly once (never toggled — 3.6b hang), and a defensive `copy-mode -q` on connect.
- [ ] The control client survives anchor-session destroy (`no-detach-on-destroy`) and tmux-server restart (reconnect + backoff + re-bootstrap, generation/pid read FIRST on each connect, all cached ids discarded on `%exit`).
- [ ] The current real (non-control) client's focused session/window/pane is captured via notifications-as-signal + a debounced, single-in-flight framed re-read (`list-clients` + `list-panes -a`) over the same connection; idle ⇒ 0 events; folded into the live-only singleton `tmux_client_focus` (last-write-wins UPSERT, NO floor/seed).
- [ ] `keeper jobs` renders `[focus <session>:<win> %<pane>]` and `[focus: none]`, composed with the `[dead-letter:N]` pill, stamped before the body byte-compare short-circuit, and the flash-restore timer rebuilds both pills. A no-tmux / never-connecting-worker environment still first-paints (the collection emits `rows: []`).
- [ ] `SCHEMA_VERSION` bumped with `SUPPORTED_SCHEMA_VERSIONS` (`keeper/api.py`) in the SAME commit; cold `TmuxClientFocusSnapshot` rows reclaimed by a SEPARATELY-NAMED live-only delete predicate (NOT widening `NOOP_SNAPSHOT_DELETE_PREDICATE`) with its own SAFE+NECESSARY test pair.
- [ ] No real tmux in the fast test tier (pure parser + focus-derivation seams driven by golden strings); the live `tmux -C` attach test is `*.slow.test.ts`, allowlisted.

## Early proof point

Task that proves the approach: `.3` (the tmux-control-worker). If a persistent control
client reliably observes focus and survives reconnect/server-restart inside the daemon's
supervision, the whole approach holds. If it proves flaky: fall back to a tight (~200ms)
poll issuing the same framed reads for v1, keeping the identical event/projection/delivery
downstream — a producer-only swap.

## References

- Design validated by two judged design panels; control-mode behavior verified on host tmux 3.6b — a single control client attached to session A received `%session-window-changed` for session B (confirmed global, server-wide observation).
- Overlapping open epics to sequence via epic deps: `fn-946` (keeper handoff — CO-MINTS a schema version; sharpest collision: both bump `SCHEMA_VERSION` + `SUPPORTED_SCHEMA_VERSIONS`), `fn-945` (autopilot paused across reboot — shares `src/daemon.ts`/`src/reducer.ts`/`src/db.ts`/`test/refold-equivalence.test.ts`), `fn-950` (done-epics reap — shares `src/collections.ts`).
- tmux control mode: github.com/tmux/tmux/wiki/Control-Mode; CHANGES (`-N` 3.0; `no-detach-on-destroy`/`ignore-size`/`pause-after` 3.2; `no-output` off→on toggle hang fixed in 3.7 — host is 3.6b); iTerm2 #2302 (parser infinite-loop → max-iteration guard), #9133 (`pause-after` hygiene); tmux #3193 (config-error → copy-mode hang).

## Docs gaps

- **README.md `## Architecture`**: add the new worker to the thread enumeration; add `tmux_client_focus` to the `LIVE_ONLY_PROJECTIONS` taxonomy; bump the registered-collections count; extend the `NOOP_SNAPSHOT_DELETE_PREDICATE` passage to note the separate focus predicate; add focus to the `keeper jobs` banner description; add the "As of schema vN" callout.

## Best practices

- **Frame by command number:** match `%begin`/`%end`/`%error` by command number only (3 ints); inside a block any `%`-line is body, not a notification; parse-and-ignore unknown `%`-verbs; explicit max-iteration bail-out in the parser (iTerm2 #2302 loop class).
- **`no-output` set once, never toggle:** the off→on toggle hangs the client on ≤3.6 (this host is 3.6b); send `copy-mode -q` defensively (no `%config-error` on 3.6b → a config error would otherwise silently hang the client).
- **Dedicated async reader draining into a queue:** never block the reader on a DB write or a synchronous command — a notification burst against a stalled reader fills the (small, on macOS) pipe and triggers `%exit "too far behind"`.
- **Discard cached ids on `%exit`/server restart:** tmux hands out pane/window/session ids monotonically from zero and reuses them across restarts; rebuild via framed re-read, reading the server pid (generation) first.
