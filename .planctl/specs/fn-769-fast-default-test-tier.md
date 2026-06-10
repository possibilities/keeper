## Overview

Default `bun test` drops from 65.5s to <5s wall by killing the suite's dominant cost — ~1,200 per-test `openDb()` calls each re-running the full 63-version migration ladder (~40ms ≈ 48s of CPU jamming `--parallel` on 10 cores) — and tiering the process-level integration files behind a new `test:full` script. Mechanism: migrate one `:memory:` DB per process, `db.serialize()` it, `Database.deserialize(template)` per test (~0.2ms, validated: real reducer.test.ts passes 470/470 at 28.9s → 6.5s with the swap). No test is deleted; the human has explicitly accepted that the default run loses the integration files' coverage (daemon boots, hook subprocess spawns, git plumbing, migration ladder), which still run under `test:full`.

## Quick commands

- `time bun test` — fast tier + opentui; must finish <5s wall on the 10-core dev machine
- `bun run test:full` — everything (slow integration tier included), green in ~35s
- `bun test test/reducer-*.test.ts` — the sharded fold tests alone

## Acceptance

- [ ] Default `bun test` <5s wall on the 10-core dev machine, all included tests passing
- [ ] `test:full` runs every test file (fast + slow + opentui, no double-run of opentui) and is green
- [ ] No test deleted; db.test.ts still exercises the real migration ladder (slow tier)
- [ ] Template helper hard-throws on schema-version mismatch (stale-template guard)
- [ ] CLAUDE.md + README document the helper and when `test:full` is mandatory

## Early proof point

Task that proves the approach: `.1` (helper + reducer.test.ts adoption — the exact swap already validated by probe: 470/470 pass, 28.9s → 6.5s). If deserialize misbehaves in some edge case: fall back to the file-copy template variant for that file — still a ~15x win over re-migrating.

## References

- Measured baseline (2026-06-09): suite 65.5s wall / 2,763 tests / 59 files; reducer 28.9s solo (470 tests, openDb-per-test); daemon 33.3s solo; git-worker 15.5s; plan-worker 8.1s; db 6.6s; server-worker 6.4s; events-writer 4.7s; collections 2.5s; everything else ≤1.5s solo. openDb(":memory:") ≈ 27-40ms each, dominated by the v63 migration ladder.
- Prior art: fn-752 (one `--parallel` tier + `test:opentui` via `--path-ignore-patterns` — the tier-split pattern to extend), fn-747 (startDaemon watcher seam that made the slow tier parallel-safe), fn-749 (worker-set selector).
- `fn-767` (overlap) — its quick-commands run `bun test test/server-worker.test.ts`, and this epic rewrites server-worker.test.ts setup; land/rebase carefully.
- `fn-766` (overlap) — working tree carries in-flight changes to test/keeper-watch.test.ts, which task .2 also touches; this epic should land after fn-766's test changes.
- Follow-up epic (human-stated, NOT in scope): local CI daemon that auto-runs `test:full` on new commits and feeds failures back into keeper; repo-generic.
- One pre-existing flaky test observed (1 fail on a full run, passed on rerun) — not part of this work, do not chase.

## Docs gaps

- **CLAUDE.md `## Test isolation`**: add the template-DB-helper rule (when to use it vs fresh openDb) and the tier-split line — "fast tier is the default; `test:full` is mandatory before landing changes touching daemon/worker/db/hook/git process paths or any slow-tier file."
- **README.md sandboxEnv paragraph (~549-568)**: revise (don't append) to name both helpers — `sandboxEnv` for process-spawn isolation, template-DB for pure in-process unit tests needing a migrated schema.

## Best practices

- **Serialize from `:memory:` ONLY:** `sqlite3_deserialize` rejects WAL-mode images (SQLITE_CANTOPEN); WAL is a no-op on `:memory:` so the memory-built template is safe by construction — a file-built template would be a WAL image and fail. [sqlite.org/c3ref/deserialize.html]
- **Pragmas are not serialized:** `foreign_keys` is OFF immediately post-deserialize (verified) — the helper must run `applyPragmas` on every clone, never skip it.
- **`Database.deserialize(buf, true)` sets `strict`, NOT `readonly`:** use the options-object form; leave a footgun comment. [bun.com reference]
- **Fresh stmts per clone:** prepared statements never cross `Database` instances; `prepareStmts` runs per deserialize.
- **`--parallel` is one process per file** (bun ≥1.3.13): the module-scope template rebuilds per file-process (~8-40ms once) — fine; no cross-file sharing exists.
- **Two-tier rot:** the dominant failure mode is the slow tier breaking silently — the CLAUDE.md note is the only tripwire until the follow-up local-CI epic lands.
