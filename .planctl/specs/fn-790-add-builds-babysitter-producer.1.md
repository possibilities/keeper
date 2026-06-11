## Description

**Size:** M
**Files:** babysitters/builds/watch.ts, babysitters/builds/watchdog.ts, babysitters/agents/builds.md, plist/arthack.babysitter.builds.watch.plist, plist/arthack.babysitter.builds.watchdog.plist, test/builds-watch.test.ts, test/babysitter-build.test.ts, package.json, README.md

### Approach

Clone the `performance` sitter shape into `babysitters/builds/` with one
structural difference: **no findings notifications.** The tick pipeline is
scan → diff seen-state → spawn the `babysitters:builds` agent for new
findings → agent writes one followup per finding (frontmatter-canonical
`key:`, per the performance.md:266-326 contract) and acks — it never calls
`botctl` on the findings path. Cold start writes followups for
currently-red steps (no silent baseline — with no pages there is no storm,
and pre-existing reds are exactly the backlog triage wants).

Surface: open `~/.local/state/buildbot/master/state.sqlite` read-only
(`{readonly: true, prepareStmts: false}`; WAL mode confirmed, snapshots
are consistent). Per builder, walk completed builds past a per-builder
high-water cursor (stored in seen-state). A build with `complete_at`
set and `results` in {2 FAILURE, 4 EXCEPTION} yields findings from its
failed steps (`steps.results` non-zero, mirroring notify.py
`_failed_steps`); skip WARNINGS/SKIPPED/RETRY/CANCELLED and any
incomplete build (`complete_at IS NULL` — the #1 false-positive class).

Key scheme (publishes to the charter, settle as): category from the step
class — `test-failure` (test/test:full/test:e2e), `lint-failure`,
`typecheck-failure`, `build-exception` (results=4 with no failed step);
key = `<category>:<sanitized-step>:<builder>` (sanitize `:` and `.` to
`_` — `test:full` would otherwise corrupt the `:`-delimited key).
Fingerprint = hash(category, resourceId, FINGERPRINT_VERSION=1), no
timestamps/counts. Occurrence semantics: a seen entry suppresses
re-followups while the step stays red; observing the step green CLEARS
its entry, so the next red onset writes a fresh followup whose
filename ts drives the ledger resurface rule.

Degrade, never wedge: missing DB / SQLITE_BUSY / schema skew (buildbot
upgraded past 4.3.0) → empty findings, heartbeat still stamped, exit 0.
Reuse `babysitterStateDir('builds')` for all state; atomic writes;
versioned seen-state schema (mismatch → rescan). Ship the sibling
watchdog (heartbeat staleness → page topic `Keeper` — the one
notification that remains) and both plists (300s StartInterval, abs
paths, `--tick`). Keep keeper-src imports minimal — the import-pin test
enforces the surface.

### Investigation targets

**Required** (read before coding):
- babysitters/performance/watch.ts:2415 — tick() orchestration; :1958-1983 + :2034 + :2227 seen-state shapes/load/fold; :202-213 fingerprint; :185 Finding
- babysitters/agents/performance.md:266-326 — the followup frontmatter contract (`key`/`fingerprint`/`category`/`severity`, YAML-scalar guarding, injection-safe heredoc)
- babysitters/FINDINGS-LEDGER.md — key join, three-shape extraction, resurface rule the followup filenames feed
- ~/code/arthack/system/buildbot/notify.py:138 — `_failed_steps` predicate; :151+ — the FAILURE+EXCEPTION/skip-cancelled semantics to replicate
- ~/.local/state/buildbot/master/state.sqlite — live schema: `builds(id,number,builderid,complete_at,results,state_string)`, `builders(id,name)`, `steps(buildid,name,results,state_string)`
- test/babysitter-build.test.ts:44 — SITTER_ENTRYPOINTS array to extend

**Optional** (reference as needed):
- babysitters/performance/watchdog.ts — dead-man template
- babysitters/lib/state.ts:14 — babysitterStateDir
- plist/arthack.babysitter.performance.watch.plist — launchd template
- test/keeper-watch.test.ts:1-21 — the two-layer test shape
- babysitters/performance/watch.ts:2331 — spawnAgentLive + spawn-failure retry cap
- src/builds-worker.ts — fn-781's REST poller (the fallback interface)

### Risks

- Schema pin to buildbot 4.3.0 — an upgrade is the silent-breakage vector; the degrade path plus the watchdog's staleness page is the safety net. Fallback interface: the REST API builds-worker already uses.
- Agent-spawn per finding can fail silently — reuse performance's spawn_failures retry cap so a broken spawn doesn't retry every 300s forever.
- A builder with zero builds, or removed from buildbot, must scan to nothing (skip, not crash); seen-state TTL prune reclaims vanished builders.

### Test notes

Two layers per test/keeper-watch.test.ts: (1) pure detectors fed
hand-built rows (every results code, incomplete build, multi-failed-step
build, `test:full` sanitization, green-clears-seen, cold-start) — no DB;
(2) scan against a seeded sandbox `state.sqlite` in a tmpdir with
`BABYSITTER_STATE_DIR` pointed there. Add the heavy file to
package.json:16 `--path-ignore-patterns`; extend the import-pin. Run
`bun run test:full` before landing (daemon/db/hook-adjacent paths).

## Acceptance

- [ ] `--tick` against a seeded sandbox DB writes exactly one followup per red onset (frontmatter-canonical `key:`), none for incomplete/cancelled/retry/warnings builds, none repeated while a step stays red, and a fresh one after green→red
- [ ] Cold start on an already-red builder produces followups (no silent baseline)
- [ ] No `botctl` invocation anywhere in the findings path; watchdog pages topic `Keeper` on heartbeat staleness only
- [ ] Missing buildbot DB → exit 0, empty findings, heartbeat stamped
- [ ] `babysitters/builds/watch.ts` + `watchdog.ts` in SITTER_ENTRYPOINTS; `bun run test:full` green
- [ ] Both plists ship; README gains the builds install step and drops the stale "future sitters" aside

## Done summary
Shipped the builds CI-failure collector sitter: read-only buildbot state.sqlite scanner (immutable=1 open for WAL safety) + collector agent that writes one followup per red onset with no findings-path page, sibling dead-man watchdog, two plists, README install + architecture sections, and a two-layer test suite. Validated live against the real buildbot DB (3 currently-red builders surfaced correctly).
## Evidence
