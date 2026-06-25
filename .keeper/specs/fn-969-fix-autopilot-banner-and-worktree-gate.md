## Overview

Three read-side fixes to the `keeper autopilot` CLI surface. The worktree-mode
banner is permanently stuck on `worktree:off` because the wire descriptor omits
the column; the `worktree <on|off> --force` mid-epic gate over-fires on the
operator's own interactive session because it gates on any live job; and
per-root concurrency (`max_concurrent_per_root`) is configurable but never
rendered on the banner. End state: the banner truthfully shows worktree-mode
and per-root state, and `--force` is required only when a started epic is
genuinely in flight. No schema / RPC / protocol change — every column and the
per-root setter already exist.

## Quick commands

- `keeper autopilot worktree on && keeper autopilot --snapshot` — expect `worktree:on` in the banner
- `keeper autopilot config max_concurrent_per_root 3 && keeper autopilot --snapshot` — expect `per-root 3`
- `keeper autopilot worktree on` on a drained board (no started epics) — succeeds WITHOUT `--force`
- `bun test test/autopilot.test.ts test/collections.test.ts` then `bun run test:full`

## Acceptance

- [ ] Banner shows `worktree:on`/`worktree:off` reflecting the real durable toggle
- [ ] Banner always renders a `per-root N` segment, positioned `... · max N · per-root M · worktree:STATE`
- [ ] `worktree <on|off>` requires `--force` ONLY when a started open epic exists (isEpicStarted); a drained / unstarted-open / zero-epic board toggles freely; a transport error still fails closed
- [ ] `bun run test:full` green

## Early proof point

Task that proves the approach: `.1` (serve `worktree_mode`). `keeper autopilot worktree on`
then `keeper autopilot --snapshot` should show `worktree:on`. If it fails: the column may
need different handling or the serve path differs — re-read `src/server-worker.ts:1335` (runQuery
projects only `descriptor.columns`).

## References

- `isEpicStarted` — `src/readiness.ts:115` (null-safe, pure, exported; plan-verb-only + all-todo → false)
- `queryCollection` — `cli/control-rpc.ts:175` (`limit:0`, decodes JSON columns at the read boundary)
- `DEFAULT_MAX_CONCURRENT_PER_ROOT = 1` — `src/db.ts:216` (NULL here = default 1, NOT unlimited)
- Served-columns test pattern — `test/collections.test.ts:376-399`
- epic-scout: no deps/overlaps with open epics; only open epic `fn-968` (tmux topology) is orthogonal

## Docs gaps

- **README.md** (`keeper autopilot` subsection, ~line 1091): add `per-root N` to the banner-segment enumeration and note the banner now reflects worktree-mode state
- **README.md** (~lines 3177-3179): revise the worktree `--force` guard prose in place — "any live job" becomes "any started open epic"
- **cli/autopilot.ts** `--help` / `--agent-help`: update the worktree `--force` line and the banner-segment description
- **CLAUDE.md** `## Autopilot`: confirm-and-skip — the README pointer stays valid, no content add expected

## Best practices

- **Keep descriptor columns / projection / render in sync:** a read-side field absent from `descriptor.columns` is silently never served (the worktree bug). The served-columns regression test is the durable guard against re-drift.
- **Render the banner as a pure function with golden-string tests:** fast tier, no PTY; the required new param forces every golden string to update in lockstep at the type level.
- **Inject the query transport for the gate test:** a DI param (default `queryCollection`) keeps the gate unit test off the daemon socket, fast-tier.
