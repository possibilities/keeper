## Description

**Size:** M
**Files:** plugin/hooks/events-writer.ts, src/reducer.ts, CLAUDE.md, test/reducer.test.ts

### Approach

Populate the three primary coords on every event and project them onto `jobs`. In `events-writer.ts`, call `execBackendEnvMeta()` (from T1), read the two named env vars plus stamp `backend_exec_type = meta.backendType`, normalizing absent/empty to NULL (mirror `configDirFromEnv`) — a pure synchronous `process.env` read with no fork/fs/PPID-walk, on EVERY event (not SessionStart-gated). Wire the values into `insertBindings`. In `src/reducer.ts`, add a latest-non-null fold arm that applies on every event type (not just SessionStart): `backend_exec_* = COALESCE(excluded.col, jobs.col)`. The fold reads only the event payload (env was frozen onto the row at hook time), so a cursor-0 re-fold stays byte-identical. Widen CLAUDE.md's "Scraping is scoped" bullet to carve out `ZELLIJ_SESSION_NAME`/`ZELLIJ_PANE_ID`/`ZELLIJ` as permitted pure every-event reads while preserving "no fork, no fs, no PPID-walk."

### Investigation targets

**Required** (read before coding):
- plugin/hooks/events-writer.ts:208-231 — configDirFromEnv (pure normalizer template)
- plugin/hooks/events-writer.ts:565,572-582 — config_dir SessionStart-gated capture + cold-start budget warning (the new reads must stay pure/synchronous, but NOT SessionStart-gated)
- plugin/hooks/events-writer.ts:593-623 — insertBindings (set the real values here)
- src/reducer.ts:5476-5528 — SessionStart COALESCE fold (the model; the new arm fires on every event)
- CLAUDE.md:201-207 — "Scraping is scoped" invariant (widen, don't break the spirit)
- test/reducer.test.ts:60-140 — fold-then-assert pattern + makeEvent

### Risks

- Invariant widening: this deliberately permits non-SessionStart env reads, which CLAUDE.md currently forbids — the doc edit must land in the same change or the change reads as invariant-violating.
- Re-fold determinism: the fold must never re-read env — only the payload. Verify with a re-fold test (insert events, fold, re-fold from cursor 0, assert identical jobs rows).
- Every-event fold must not regress `config_dir`'s SessionStart-only arm.

### Test notes

Add reducer tests: latest-non-null across multiple event types; NULL-carrying event does not clobber a prior non-null; cursor-0 re-fold byte-identical.

## Acceptance

- [ ] Hook stamps `backend_exec_{type,session_id,pane_id}` on every event as pure env reads; absent env ⇒ NULL (never bogus `type='zellij'`).
- [ ] Reducer folds latest-non-null onto `jobs` across all event types; re-fold from cursor 0 is byte-identical.
- [ ] CLAUDE.md "Scraping is scoped" carve-out added for the zellij env vars.
- [ ] New reducer tests green; `config_dir` fold unchanged.

## Done summary

## Evidence
