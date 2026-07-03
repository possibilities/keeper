## Overview

Browser-grade "restore tabs" for keeper-managed claude agents: after a tmux
server crash or deliberate kill-server, `keeper tabs` reliably restores the
session the human actually lost. Selection becomes recency-bounded and
richness-ranked over per-generation topology snapshots instead of "single
newest dead generation" (the defect that restored a 1-pane skeleton over a
9-pane session), resume switches to exact session UUIDs, the setup-tmux
offer reports real outcomes instead of fire-and-forget, and a durable
runnable revive script always exists on disk.

## Quick commands

- `keeper tabs list` — ranked dead-generation table + current live set
- `keeper tabs restore` — dry-run of what would be restored
- `keeper tabs dump | head -30` — runnable revive script of the current session
- `bun test test/restore-set.test.ts test/tabs.test.ts test/setup-tmux.test.ts`

## Acceptance

- [ ] The recorded incident replayed against the new selection restores the 9-pane generation, never the 1-pane skeleton
- [ ] `keeper tabs restore` works daemon-down off read-only keeper.db with strict exit codes and no silent no-op anywhere on the path (setup-tmux offer included)
- [ ] A revive script can be dumped at any moment and a durable one is maintained automatically by the daemon

## Early proof point

Task that proves the approach: ordinal 1 (bounded generation selection). If
the VIRTUAL generated-column migration fails under bun:sqlite, fall back to
a plain expression index plus a DESC walk that accumulates K distinct
generations with no row cap.

## References

- Live-DB evidence: a rich dead generation (9 panes) was shadowed by a newer 1-pane skeleton generation and the skeleton got restored; the 256-row scan window degrades to the killed-cohort fallback whenever the current server is long-lived; topology snapshots emit in unattributed/attributed pairs (0 then N job_ids)
- tmux-resurrect / tmux-continuum: persist topology, restore selectively and idempotently; the single-pane skeleton is the documented hazard; capture (daemon) and restore (CLI) stay separate roles
- SQLite expression indexes match only textually identical expressions; a VIRTUAL generated column indexed as a plain column removes that footgun; EXPLAIN QUERY PLAN is the acceptance instrument
- `claude --resume <uuid>` resolves only within the session's project dir + its git worktrees — the cwd prefix on every resume command is load-bearing

## Docs gaps

- **CLAUDE.md**: retarget the `restore-agents --apply` guardrail line to the `keeper tabs restore --apply` spelling (revise in place, same invariant)
- **docs/problem-codes.md**: add the tabs command-family section in the same change that introduces its envelope codes
- **README.md**: add `tabs` to the example-clients bullet; keep tab-restore distinct from the DB "Backup & restore" section

## Best practices

- **Exact-expression index matching:** the query must contain the indexed expression byte-for-byte, or use a generated column so any column-name query hits the index [sqlite.org/expridx]
- **Generated scripts are an untrusted-data-to-code boundary:** single-quote every interpolated field (titles, cwds), 0600 the side-file [BashPitfalls]
- **Dedicated exit code for non-interactive refusal,** distinct from runtime failure, so orchestrators can tell policy refusal from error [gh CLI precedent]
- **Atomic side-file writes:** temp in same dir, fsync, rename; hash-gate to skip no-op rewrites [write-file-atomic]
