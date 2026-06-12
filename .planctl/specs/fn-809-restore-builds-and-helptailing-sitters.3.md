## Description

**Size:** M
**Files:** sitters/builds/watch.ts (new), test/builds-watch.test.ts (new), test/helpers/buildbot-fixture.ts (new), test/fixtures/buildbot schema fixture (new), test/build-pin.test.ts, plist/arthack.babysitter.builds.watch.plist (new), agents/builds.md (new), tsconfig.json, package.json, README.md, CLAUDE.md

### Approach

Recover `babysitters/builds/watch.ts` from keeper history. Keep the scan side intact: openBuildbotDb with the `file:<path>?immutable=1` read-only open against buildbot's `~/.local/state/buildbot/master/state.sqlite` (BUILDBOT_STATE_SQLITE override), the self-contained buildbot-4.3.0 schema pin, per-builder cursors, and green-clear onset semantics. Replace the collection path: excise the headless-claude spawn (PLAIN_CLAUDE_PATH, plugin-dir, TRIAGE_AGENT constants at old lines 668-671, the ack-file protocol, and spawn plumbing) and write findings directly via lib/followups.ts with a FOLLOWUP_CONFIG, pull-model like the other sitters — the human triages via /babysit-triage builds. Do NOT port builds/watchdog.ts, its plist, or its tests — no paging; stamp heartbeat.json like the other sitters. Imports become `atomicWriteFile` from `../../lib/keeper-compat` + `babysitterStateDir` from `../../lib/state` only (no schema-pin.ts, no openDbReadonly — different database). Build a buildbot-schema test helper + fixture (fixture-db.ts is keeper-specific: it inserts meta.schema_version, which buildbot lacks); adapt the old watch tests, dropping agent-spawn/ack suites and adding direct-writer coverage; ensure a failed followup write leaves its onset uncommitted so it retries next tick (this replaces the old spawnFailed handling). Rewrite agents/builds.md as a pull-model producer doc describing current behavior only. Add the watch plist; wire tsconfig, lint glob, build-pin, README.

### Investigation targets

**Required** (read before coding):
- `git -C ~/code/keeper show '8f8da06e~1:babysitters/builds/watch.ts'` — whole file; openBuildbotDb ~line 581, spawn constants 668-671, seen-state fold/onset selection
- lib/followups.ts + the FOLLOWUP_CONFIG wiring in sitters/performance/watch.ts — the direct-writer pattern to converge onto
- test/helpers/fixture-db.ts — the helper shape to mirror for a buildbot fixture (do not reuse: meta table is keeper-only)

**Optional** (reference as needed):
- `git -C ~/code/keeper show '8f8da06e~1:test/builds-watch.test.ts'` — old coverage map; agent-spawn suites drop, scan/cursor suites port
- agents/gitpolice.md — producer-doc shape for the rewrite

### Risks

- The `file:...?immutable=1` open form is a silent-ENOENT trap if Bun does not URI-parse it — verify the exact production form against the current Bun with a seeded fixture before building on it.
- immutable=1 reads bypass WAL: confirm buildbot's actual journal mode and write the opener comment truthfully instead of copying the old WAL claim.
- Cold start emits followups for every currently-red step (no silent baseline) — confirm the backlog is acceptable and note the behavior in agents/builds.md.

### Test notes

Buildbot-fixture tests cover: onset detection across ticks, green-clear cursor semantics, failed-write retry (onset stays uncommitted), schema-pin mismatch -> empty scan + exit 0, immutable URI open against a real fixture file.

## Acceptance

- [ ] sitters/builds/watch.ts supports table/--json/--tick; exits 0 on missing DB, locked DB, and buildbot schema skew
- [ ] no claude spawn, no watchdog file/plist/tests anywhere in the repo; findings flow through lib/followups.ts
- [ ] immutable=1 open form verified by a test against a seeded fixture file
- [ ] buildbot fixture + adapted suite green; build-pin covers the entrypoint; fence green
- [ ] agents/builds.md rewritten for the pull model; plist + tsconfig/lint/README wiring landed

## Done summary

## Evidence
