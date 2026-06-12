## Overview

Restore the builds and helptailing sitters — lost when the fn-795 extraction deleted keeper's babysitters/ tree after porting only performance — into ~/code/sitter, converted to the vendored-lib conventions. All sitter binaries collect under a single sitters/ tree (performance and gitpolice relocate there too). builds converges on the pull model: scan buildbot, write findings directly via lib/followups.ts, human triages via /babysit-triage — no headless-agent collection, no watchdog paging. End state: four sitters under sitters/<slug>/, four launchd watch jobs ticking, docs forward-facing.

## Quick commands

- cd ~/code/sitter && bun test
- bun run sitters/builds/watch.ts --json && bun run sitters/helptailing/watch.ts --json
- launchctl list | grep arthack.babysitter   # four watch jobs, last exit 0

## Acceptance

- [ ] all four sitters live under sitters/<slug>/; no sitter dirs at the repo root
- [ ] builds + helptailing restored from keeper history (`git -C ~/code/keeper show '8f8da06e~1:babysitters/...'`) conforming to repo invariants: vendored lib only (zero-keeper-import fence green), keeper.db readers gated by lib/schema-pin.ts, always exit 0 under launchd
- [ ] builds is pull-model: direct followups via lib/followups.ts, no claude spawn, no watchdog file/plist/tests
- [ ] four launchd watch jobs symlinked, bootstrapped, healthy (including the previously unbootstrapped gitpolice job)
- [ ] bun test green; README/CLAUDE.md/agents docs describe current state only

## Early proof point

Task that proves the approach: `.2` (helptailing — the first restore-from-history + vendored-conversion). If it fails: land a verbatim restore without the gate adoption and iterate the conversion in a follow-up task.

## References

- Source of truth: keeper commit `8f8da06e~1` — babysitters/builds/watch.ts, babysitters/builds/watchdog.ts (NOT ported — watchdog dropped by convergence), babysitters/helptailing/watch.ts, babysitters/agents/{builds,helptailing}.md, plist/arthack.babysitter.{builds.watch,builds.watchdog,helptailing.watch}.plist, test/{builds-watch,builds-watchdog,helptailing-watch}.test.ts
- Precedents: sitter repo commit a5dd2c1 (gitpolice — newest full-sitter wiring: lint glob, tsconfig, build-pin, plist), f8b13e8 (schema-pin hoist), 8c7a1a8 (lint scoping); keeper fn-795 (the performance conversion pattern this port mirrors)
- Old builds agent-spawn constants (keeper babysitters/builds/watch.ts:668-671: REPO_ROOT/plugin-dir/TRIAGE_AGENT) — removed by the pull-model convergence, listed so the worker knows what to excise

## Docs gaps

- **README.md**: roster prose (lines 16-17), Install/Uninstall blocks gain three new watch labels, Tests block gains two --json lines, "gates BOTH sitters" schema-pin prose generalizes to keeper.db readers, stale performance-watchdog retirement lines 94-97 pruned
- **CLAUDE.md**: Layout section describes the sitters/ tree with builds/helptailing entries; opening roster sentence names all four
- **agents/builds.md + agents/helptailing.md**: new load-bearing producer docs — babysit-init gates on `test -f agents/<slug>.md`

## Best practices

- **immutable=1 bypasses WAL entirely:** reads see only last-checkpointed state — verify buildbot's actual journal mode and document it truthfully rather than copying the old WAL claim [sqlite.org/wal.html]
- **busy_timeout and query_only are per-connection:** must be set after every open — openDbReadonly already does both [sqlite.org/pragma.html]
- **StartInterval counts from job exit, RunAtLoad refires on every reload, never combine with KeepAlive** [launchd.plist(5)]
- **Open/read/close per tick:** a persistent WAL reader blocks checkpoint truncation on the owner's side [sqlite.org/wal.html]
