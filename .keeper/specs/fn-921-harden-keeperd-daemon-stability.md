## Overview

Three independent root causes behind the 2026-06-23 keeperd wedge — landed as
one epic. **T1 (file-local durable git surface, `.1`)** is the priority: the
git-surface freeze darks ALL keeper-root autopilot dispatch (it blocks the
fn-918 closer and fn-919.2). **T2 (`.2`)** kills the server-worker CPU peg.
**T3 (`.3`)** makes a live agent reachable on the bus. **T4 (`.4`)** is the
commit-work synced-attribution barrier — split out of `.1` because it crosses
the process boundary into commit-work's own files (it was bundled into `.1`'s
git-surface scope by mistake). End state: the git surface self-recovers without
a manual bounce, the server-worker no longer pegs a core, live agents are
reachable, and commit-work reads a consistent attribution set.

## Quick commands

- `keeper jobs` returns within ~1s; `keeper bus list` shows live agents `subscribed:true`
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT seed_required FROM git_projection_state"` → clears to 0 on a healthy boot, and a stuck `1` self-recovers
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT COUNT(*) FROM events WHERE hook_event='GitSnapshot' AND id > (SELECT floor FROM git_projection_state)"` → non-zero on a quiet repo with seed_required set
- per-thread CPU on the daemon settles to low idle (no server-worker `sendto` storm)

## Acceptance

- [ ] git surface recovers a stuck `seed_required` WITHOUT a manual daemon bounce; autopilot keeper-root dispatch un-darks once seeded (`.1`)
- [ ] git producer survives a `@parcel/watcher` load-hang / mute (`.1`)
- [ ] server-worker no longer sends full `subagent_invocations` snapshots per event; no CPU peg (`.2`)
- [ ] a live, sending agent is reachable by directed bus send AND appears in `keeper bus list`; fn-918 durable wake-on-send preserved (`.3`)
- [ ] `keeper commit-work` reads a consistent `(file_attributions, live-dirty)` set — a file edited immediately before commit-work is still attributed + staged (`.4`)
- [ ] `bun run test:full` green

## Early proof point

Task that proves the approach: `.1` (file-local durable git surface) — it proves the un-dark, the highest-value + highest-risk piece. If it fails: the gated-root key-mismatch reconciliation or the watchdog escalation needs rework.

## References

- Incident handoff: `~/docs/keeper-daemon-wedged-cpu-pegged.md`
- `fn-905` (per-root git boot-seed gate) — `.1` builds on / modifies this readiness-gate surface
- **fn-918 overlap NOTED but deliberately NOT wired as a dep**: fn-918 (done, awaiting close) writes `src/bus-worker.ts` + `cli/bus.ts` (same files as `.3`), but its closer is itself blocked by the git-surface freeze `.1` fixes — wiring this epic to depend on fn-918 would deadlock. Managed by sequential execution: `.1` lands → reboot un-darks fn-918's closer → fn-918 closes → `.3` edits those files last.
- `.4` was split out of `.1` (fn-921.1 SCOPE_EXCEEDED): the synced-attribution barrier crosses into commit-work's process + files, not the git-surface file set.

## Docs gaps

- **README.md**: `@parcel/watcher` load-ordering block (git-worker → poll-only), the "single third-party dep" claim, git change-detection prose, boot-seed contract (watchdog + dead-vs-stuck), subscribe protocol (`subagent_invocations` recency bound), bus presence model (register-without-subscribe valid + Monitor re-arm)
- **CLAUDE.md**: boot-seed contract ("never a retry loop" narrows for the watchdog), worker contract (supervisor probes git-worker liveness), bus worker rules (register-without-subscribe is a valid connected state)
- New `.keeper/specs/` entries per task; do NOT edit closed specs

## Best practices

- **Supervisor-side liveness over unilateral heartbeat;** prefer crash-and-LaunchAgent-restart over in-process respawn. [practice-scout]
- **Two-tier poll + debounce:** cheap `stat()` of `.git` metadata at ~300ms, run the git scan only on a detected mtime delta; coalesce 100–500ms. [practice-scout]
- **Never refetch from inside the send path; bound subscription result sets.** [practice-scout]
- **Only a SUBSCRIBED connection is a valid dispatch target;** reap on close AND on heartbeat-timeout. [practice-scout]
