## Overview

Chrome-style "restore previous session" for keeper-managed Claude Code
agents. A new pure-consumer Worker thread continuously snapshots the
live job + zellij backend-exec metadata to `~/.local/state/keeper/restore.json`
(latest-always, written only when content changes), and a manual util
script `scripts/restore-agents.ts` replays those agents into
get-or-create'd zellij sessions via the exact `claude --resume` commands
`scripts/resume.ts` builds today — dedup'd against jobs that are still
live. The restore file is a derived side-file, NOT a projection and NOT
in the event log, so this sidesteps the event-sourcing / re-fold-determinism
invariants entirely (no schema bump, no `keeper/api.py` whitelist change,
no reducer arm).

## Quick commands

- `KEEPER_RESTORE_FILE=/tmp/r.json bun test test/resume-descriptor.test.ts test/restore-worker.test.ts` — unit suites
- `cat ~/.local/state/keeper/restore.json | jq` — inspect the live snapshot
- `bun scripts/restore-agents.ts` — dry-run (default): print what would be restored
- `bun scripts/restore-agents.ts --apply` — actually relaunch all surviving agents
- `bun scripts/restore-agents.ts --session autopilot --apply` — restore one zellij session

## Acceptance

- [ ] A tenth daemon Worker maintains `~/.local/state/keeper/restore.json` write-on-change, surviving daemon restart without churning the file.
- [ ] `restore-agents.ts` (dry-run default, `--apply` explicit; `--session <name>` or all) relaunches surviving agents via the same resume command shape `resume.ts` emits, skipping job_ids still live.
- [ ] `ExecBackend.ensureLaunched` get-or-creates an arbitrary zellij session then launches a tab into it, no stray default tabs.
- [ ] `resume.ts`, the worker, and `restore-agents.ts` build byte-identical resume descriptors from one shared pure helper.
- [ ] No schema bump; `bun test` green; lint clean.

## Early proof point

Task that proves the approach: `restore-previous-session.3` (the worker
writing a real `restore.json` from live jobs). If it fails: the descriptor
shape or the watchLoop/runQuery read path is wrong — fall back to inspecting
`autopilot-worker.ts:loadReconcileSnapshot` for the exact read seam before
reshaping the worker.

## References

- `scripts/resume.ts:306-376` — the resume-command logic this epic extracts and reuses
- `src/autopilot-worker.ts:1045-1111` — `loadReconcileSnapshot` read() helper to mirror
- `src/backend-worker.ts` / `src/wake-worker.ts` — worker-contract skeletons
- `src/exec-backend.ts:822-1151` — `createZellijBackend`, private `ensureSession`, orphan reap, session-gone retry

## Docs gaps

- **README.md `## Architecture`**: add the tenth-worker paragraph + bump the "nine workers" summary; widen the `ExecBackend` paragraph for `ensureLaunched`; add `restore.json` to the `~/.local/state/keeper/` file inventory.
- **CLAUDE.md / AGENTS.md**: add a sole-writer carve-out sentence (restore-worker is sole writer of `restore.json`, pure consumer, no event-log writes), mirroring the dead-letter-worker carve-out phrasing; add `KEEPER_RESTORE_FILE` to the test-isolation env-var list.
- **scripts/resume.ts header**: note the extracted shared helper once `resume.ts` becomes a thin consumer of it.

## Best practices

- **Write-on-change via stable hash, not timestamp:** serialize a stable-sorted descriptor (sort agents by `job_id`), hash it, keep `lastHash` in memory, skip the write when unchanged. Never let `updated_at`/`last_event_id`/wall-clock into the hashed shape or every tick churns the file.
- **Snapshot is a hint, not truth:** the replay util validates against live jobs at restore time rather than trusting the file's view of "running."
- **Parse failure = no snapshot:** the util try/catches `JSON.parse` and treats any malformed/absent file as "nothing to restore" (exit 0, clear message), never a stack trace.
- **Schema-version the side-file independently:** a top-level `schema_version` (its own constant, NOT the DB schema version); an unknown FUTURE version makes the util refuse to restore rather than act on garbage.

## Snippet context

No promptctl snippets or bundles attached: the scout harvest surfaced zero
snippet mentions, and keeper's own Bun/TS daemon internals are not covered
by the promptctl snippet index (which targets arthack CLI/Python
conventions). Nothing on the menu intersected this epic's surface.
