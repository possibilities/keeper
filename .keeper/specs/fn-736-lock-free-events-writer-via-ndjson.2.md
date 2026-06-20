## Description

**Size:** M
**Files:** plugin/hooks/events-writer.ts, src/dead-letter.ts (shared serializer), test/helpers/sandbox-env.ts, test/events-writer.test.ts, keeper/CLAUDE.md, keeper/README.md, keeper/hooks/hooks.json

### Approach

Flip the hook's write path to the NDJSON contract task .1 defined, and
take the perf win. Replace the `openDb`→`INSERT`→`db.close` happy-path
with a per-pid `appendFileSync(<pid>.ndjson, serialize(bindings)+"\n")`
(mirror the existing `deadLetter()` per-pid writer: 0600 perms, single
write() per line, no fsync, mkdir-p the dir). REMOVE the
`import { openDb, resolveDbPath } from "../../src/db"` (the perf win —
~11ms parse + ~7.5ms SQLite) and confirm no other hook symbol re-drags
`db.ts` (grep the post-change import set). Keep the hook's always-exit-0
and no-third-party-dep invariants. Reconcile the existing dead-letter
machinery: it was the INSERT-failure fallback; now the happy path IS an
append, so either repurpose dead-letter as the append-failure fallback
(ENOSPC/EACCES) or retire it — decide explicitly, don't leave two
half-overlapping NDJSON-drop systems. Add the events-log path resolver
(env-override-wins, `~/.local/state/keeper/` default, mirroring
`resolveDbPath`/`resolveDeadLetterDir`) and add `KEEPER_EVENTS_LOG` (or
the chosen name) to `test/helpers/sandbox-env.ts` so tests don't pollute
the real state dir. Re-point test/events-writer.test.ts (assert the hook
APPENDED the expected NDJSON line, not a DB row). Update the docs
(CLAUDE.md, README, hooks.json) per the epic Docs gaps. Re-run the perf
harness and record before/after. Build-forward: delete the SQLite INSERT
path, no toggle.

### Investigation targets

**Required** (read before coding):
- plugin/hooks/events-writer.ts main() ~:564-998, insertBindings ~:747-789, deadLetter/writeDeadLetter ~:799-820/:391-468 (the per-pid append pattern to mirror), the db import to drop ~:30-35
- src/dead-letter.ts — the serializer the hook keeps importing (dep-free); the NDJSON line shape defined in task .1
- test/helpers/sandbox-env.ts ~:83-89 — add KEEPER_EVENTS_LOG alongside the existing state-path env vars
- test/events-writer.test.ts — the spawn-launcher pattern; re-point assertions from DB SELECT to NDJSON-line check
- keeper/CLAUDE.md, keeper/README.md, keeper/hooks/hooks.json — the doc passages in the epic Docs gaps

### Risks

- A stray `resolveDbPath`/other `db.ts` symbol left in the hook re-drags the 6.5k-line module and erases the perf win — grep the final import set.
- Append failure (ENOSPC/EACCES/ENOENT mid-rotation) must keep the hook at exit 0 and not silently vanish events — define the fallback (retry open once on ENOENT; dead-letter or stderr on hard failure).
- Deploy-skew: this ships AFTER task .1, so new-hook/new-daemon is the steady state; the transient new-hook/old-daemon window is lag-not-loss (drained at daemon boot).

### Test notes

Re-point events-writer.test.ts to assert the appended NDJSON line + sandboxed KEEPER_EVENTS_LOG (no real-state-dir leak). Add an append-failure-still-exits-0 case. End-to-end: hook append → ingester (task .1) → events row → fold, asserted via the existing harness shape.

## Acceptance

- [ ] Hook appends a per-pid NDJSON line (0600, single write, no fsync) and no longer imports `src/db.ts`/`bun:sqlite`; import set grep confirms it
- [ ] SQLite INSERT happy-path deleted (build-forward); dead-letter reconciled (repurposed or retired, stated)
- [ ] Append failure keeps exit 0 without losing events silently
- [ ] `KEEPER_EVENTS_LOG` resolver added + wired into sandbox-env; events-writer.test.ts re-pointed and green
- [ ] Docs updated (CLAUDE.md, README, hooks.json)
- [ ] Perf harness re-run: ~6–10ms/call (down from ~22.5ms), contention flat; recorded in ~/docs/hook-perf-baseline.md

## Done summary
Flipped the events-writer hook from a direct SQLite INSERT to a lock-free per-pid NDJSON appendFileSync, dropping the src/db.ts/bun:sqlite import entirely; repurposed dead-letter as the append-failure fallback, re-pointed tests to assert the appended NDJSON line, and updated CLAUDE.md/README/hooks.json plus the perf baseline.
## Evidence
