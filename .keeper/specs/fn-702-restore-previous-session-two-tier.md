> **Superseded by fn-817-db-derived-crash-restore.** The two-tier
> `last_session` freeze model described below (boot-promote + the `>0→0`
> collapse edge + high-water peak) has been retired. The crash-restore set is
> now derived RETROSPECTIVELY from `keeper.db` at read time via per-row
> producer-stamped `close_kind` / `window_index` columns; `restore.json` is
> demoted to a dumb single-tier `current` mirror kept only as a disaster
> fallback. This spec is retained as historical record.

## Overview

keeper's `restore.json` is overwritten with whatever (often smaller) live
set exists when the snapshot last writes, so a crash / reboot / zellij-quit
that reseeds fewer agents destroys the record of the full pre-crash set
(observed live: 8 agents collapsed to 2). This epic makes restore behave
like a browser's "restore previous session": a two-tier side-file with a
frozen `last_session` restore source — written ONLY at boot-promote and the
`>0→0` collapse edge — decoupled from a continuously-mirrored `current`.
Builds on fn-677 (restore core) and fn-689 (last-non-empty floor, now
superseded by the tiering). No DB schema bump, no `keeper/api.py` change —
`restore.json` is a non-projection side-file with its own
`RESTORE_SCHEMA_VERSION` (1 → 2).

## Quick commands

- `bun test test/restore-worker.test.ts test/restore-agents.test.ts` — the two suites (set `KEEPER_RESTORE_FILE` to a tmp path)
- `cat ~/.local/state/keeper/restore.json | jq '{v: .schema_version, last: (.last_session.sessions|keys), cur: (.current.sessions|keys)}'` — inspect the two tiers
- `bun scripts/restore-agents.ts` — dry-run: prints what would be restored (now sourced from `last_session`)

## Acceptance

- [ ] After a reboot that reseeds a smaller set, `restore-agents` offers the full pre-crash set from `last_session`.
- [ ] In-daemon mass death freezes the high-water set into `last_session`; a partial collapse (survivors remain) freezes nothing.
- [ ] The two-tier v2 file round-trips worker → reader; v1 files migrate forward on first boot-promote.
- [ ] Docs (README + CLAUDE.md) reflect the two-tier contract; `bun test` green, lint clean.

## Early proof point

Task that proves the approach: `.1` — the worker writing a real two-tier
`restore.json` and the reader sourcing `last_session`, with the reboot +
multi-pulse-collapse tests green. If it fails: the high-water /
collapse-freeze edge or the boot-promote precedence is wrong — fall back to
inspecting `parseZellijWatermarks` (`src/zellij-events.ts:212`) for the safe
boot-disk-read shape and the existing floor tests
(`test/restore-worker.test.ts:340-420`) for the reboot-survival intent that
must now hold via the new mechanism.

## References

- `src/restore-worker.ts:268-346` — `restorePulse`, the central refactor (empty-skip floor `:304-306` retired)
- `scripts/restore-agents.ts:558-606` — `loadRestoreFile`, the reader fallback chain
- `src/zellij-events.ts:212-262` + `src/daemon.ts:676-689` — canonical safe boot-disk-read to mirror for boot-promote
- session `588643a1` (crash-snapshot-restore-tracking) — the prior design fork this epic resolves; fn-677 (restore core), fn-689 (last-non-empty floor, superseded)
- Chrome "Current Session" / "Last Session" + Firefox `sessionstore` four-layer model — the validated two-tier precedent (current = live mirror, last = frozen at a clean seam)

## Docs gaps

- **README.md (tenth-Worker paragraph, ~1719-1746)**: rewrite to the two-tier shape, boot-promote, collapse-freeze, retired fn-689 floor, `RESTORE_SCHEMA_VERSION 1→2` callout.
- **README.md (env-var `restore.json` summary, ~447-454)**: collapse / rewrite the inline last-non-empty-wins prose in sync so the two descriptions don't contradict.
- **CLAUDE.md (sole-writer restore paragraph, ~73-85; AGENTS.md is a symlink — edit CLAUDE.md in place)**: replace the fn-689 last-non-empty invariant with the per-tier write rules; keep the sole-writer and `KEEPER_RESTORE_FILE` test-isolation sentences intact.

## Best practices

- **`last_session` is frozen, not mirrored:** write it only at discrete seams (boot-promote + the `>0→0` collapse), never on every shrink — freezing on each shrink would restore agents the human deliberately stopped (the Chrome/Firefox model).
- **Boot-promote reads the FILE, not the projection:** the worker's DB read sees the post-`seedKilledSweep` empty set at boot; the persisted file is the only pre-crash evidence.
- **High-water is the capture mechanism, not the restore source:** track the peak so the freeze captures the richest snapshot, but restore always sources from `last_session`.
- **Atomic temp+rename for every write** (reuse `atomicWriteFile`); keep `Bun.hash` in-memory only — never persist it or compare it across boots.
- **v1 backward-read:** treat a legacy top-level `sessions` block as the `last_session` source (it was frozen under last-non-empty-wins), not as `current` — else a single empty post-upgrade pulse could clobber it.
