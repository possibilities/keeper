## Overview

Replace keeper's prospective frozen-snapshot restore (`restore.json` `last_session` tier) with a RETROSPECTIVE, read-time derivation of "the set of agent windows live right before the crash" computed from `keeper.db`. Two new producer-stamped `jobs` columns make the DB self-sufficient: `close_kind` (why a session died — `server_gone` / `window_gone_server_alive` / `pid_died` / `unknown`) and `window_index` (visual tmux order). The restore set becomes a boundary-free per-row query — a `killed` session whose `close_kind` is crash-like, that was live recently and doesn't already re-occupy a backend — resumed by stable `job_id` UUID instead of a mutable name. `restore.json` is demoted to a disaster fallback. End state: after a crash/reboot, `restore-agents` offers exactly the windows that were open, in their original order, named correctly, excluding ones the human deliberately closed — and it works with the daemon down.

## Quick commands

- `bun scripts/restore-agents.ts` — dry-run: lists crash-restore candidates (UUID + label) derived from keeper.db; must work with keeperd stopped.
- `bun run test:full` — mandatory; this epic touches daemon / reducer / db / seed-sweep / exit-watcher / restore paths.
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT job_id, state, close_kind, window_index FROM jobs WHERE state='killed' ORDER BY window_index"` — eyeball the new columns.

## Acceptance

- [ ] The restore set is derived from keeper.db at read time (close_kind-based per-row membership), not from the frozen `last_session` tier.
- [ ] `close_kind` is stamped at both producer sites (steady-state reprobe via main's exit handler, and boot-time seed-sweep) by a main-side tmux liveness probe; the reducer folds it as a pure string copy.
- [ ] `window_index` is captured into a `jobs` column so visual-order restore survives a DB-only derivation.
- [ ] Restore resumes by `job_id` UUID; a renamed session restores correctly.
- [ ] User-closed windows (`window_gone_server_alive`) are excluded; crash-killed (`server_gone` / `pid_died`) are offered.
- [ ] `restore.json` is demoted: the dumb `current` mirror remains as a disaster fallback; the freeze machinery is gone.
- [ ] `SCHEMA_VERSION` bumps land with their `SUPPORTED_SCHEMA_VERSIONS` entries in keeper/api.py in the same commit; `bun run test:full` green.

## Early proof point

Task that proves the approach: `T3` (the `src/restore-set.ts` derivation). If a close_kind-based per-row membership query cannot cleanly reproduce the pre-crash live set against real keeper.db history, the boundary-free simplification is wrong and we fall back to explicit crash-boundary detection (a DaemonBoot marker + state-as-of-boundary). Prove T3 against the recorded 2026-06-16 incident (13-session 12:24 Killed burst) before building the execution path on top.

## References

- Supersedes the freeze/snapshot restore model from fn-677 (restore-agents), fn-702 (two-tier descriptor), fn-689 (last-non-empty-wins), fn-681 (visual window order); builds on fn-789 (tmux exec backend). All are `done` — no open-epic dependencies.
- Design provenance: deep investigation of the 2026-06-16 restore incident + a two-model panel (Opus 4.8 + GPT-5.5) + empirical resolution (75% of `killed` jobs never fired SessionEnd, so `close_kind` — not SessionEnd — is the closed-vs-crashed signal).
- Key prior art: Chromium SessionService ExitType (clean/crash boundary), tmux-resurrect's blind spot (no crash/clean distinction), event-sourcing as-of-query ordering by sequence not timestamp.

## Docs gaps

- **README.md (~2348-2405, ninth-worker restore-snapshot block)**: rewrite from scratch — two-tier / boot-promote / collapse-freeze / `last_session` all go stale.
- **README.md (~522-535, env-var/test-isolation)**: trim the two-tier `{schema_version,last_session,current}` summary to "restore.json is a disaster fallback."
- **README.md (~2156-2185, exit-watcher)**: add the `close_kind` discriminator; **Architecture**: add the `close_kind` + `window_index` columns and the two `SUPPORTED_SCHEMA_VERSIONS` bumps (no DaemonBoot — boundary detection was dropped).
- **CLAUDE.md (~67-70, sole-writer)**: prune the restore-worker "maintains restore.json" sole-writer claim; the `KEEPER_RESTORE_FILE` test-isolation reference stays valid as a fallback path.
- **.planctl/specs/fn-702**: add a "superseded by this epic" note (historical record, not a rewrite).

## Best practices

- **Cut as-of queries by sequence (event_id / rowid), never by `ts`:** synthetic Killed events are stamped `Date.now()` at boot, so timestamp-keyed membership scatters; per-row `close_kind` sidesteps this entirely. [Azure/event-sourcing as-of-query]
- **Probe by UUID, never name, before restoring:** skip a candidate whose `job_id` already occupies a live backend — prevents double-spawn and is the idempotence guard against an autopilot race. [tmux-resurrect restore-into-existing]
- **Don't auto-restore on a clean restart:** a daemon upgrade doesn't kill the agents, so they never become `killed` candidates — `close_kind`/`state` gives this for free. [Chrome ExitType]
