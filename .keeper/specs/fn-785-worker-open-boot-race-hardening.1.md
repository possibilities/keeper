## Description

**Size:** M
**Files:** src/db.ts, src/wake-worker.ts, src/server-worker.ts, src/transcript-worker.ts, src/git-worker.ts, src/plan-worker.ts, src/usage-worker.ts, src/exit-watcher.ts, src/builds-worker.ts, src/autopilot-worker.ts, src/restore-worker.ts, test/db.test.ts, test/keeper-watch.test.ts (only if the watch.ts citation check below requires it)

### Approach

Two coupled changes in one reviewable pass. (a) New OpenDbOptions knob
(e.g. `bootRetry: true` or `{attempts, baseMs}`) implemented INSIDE
openDb: on a transient boot-class error anywhere in the open span (new
Database → applyPragmas → migrate-if-writer → prepareStmts), close the
failed handle best-effort, sleep synchronously (Bun.sleepSync) with
exponential backoff + jitter (default 4 attempts, base 50ms, cap 1s),
and re-run the WHOLE span with a FRESH Database. After exhaustion,
rethrow — the worker's existing fail-loud path (exit 1 → fatalExit →
LaunchAgent restart) is preserved; the code comment MUST state:
bounded, initial-open-only, transient-class-only, still fails loud —
boot robustness, NOT in-process self-heal. Classifier: NEW
`isTransientBootOpenError` next to openDb (SQLITE_BUSY/LOCKED, "no
such table"/"no such column" on prepare, SQLITE_CANTOPEN once) — do
NOT widen daemon.ts isTransientBusyError (its fn-746 CORRUPT-is-fatal
fence must stand) and never use the boot classifier outside the open
span. (b) prepareStmts:false + bootRetry on all 12 worker openDb call
sites listed in the epic References (server-worker's writer-mode open
keeps migrate:false; verify the retry wrapper preserves caller
options verbatim per attempt). events-ingest-worker is EXCLUDED (no
openDb). Main (daemon.ts:1147) keeps prepareStmts:true, no retry
(it migrates; failures there are real). Verify the contested
babysitters/performance/watch.ts prepareStmts:false citation — if
absent, this task introduces the first live noStmts() callers; add a
unit test that a {prepareStmts:false} connection works and stmts
access throws the stub error.

### Investigation targets

**Required** (read before coding):
- src/db.ts:989-1015,3293-3380 — OpenDbOptions, prepareStmts, openDb, noStmts
- src/daemon.ts:371-381 — isTransientBusyError (the fence NOT to widen)
- src/wake-worker.ts:103-160 — the canonical sync worker main() + open site (the build-86 crash path)
- src/server-worker.ts:2660-2670 — the dual open (readonly + writer-mode migrate:false)
- test/daemon.test.ts:3114-3220 — WorkerSpy/ALL_WORKERS registry (must not perturb; in-place edits only, no new spawned modules)

### Risks

- Widening retry beyond the open span or beyond the boot class would erode the no-self-heal invariant — keep the classifier private to openDb's retry
- A retry that reuses the constructed Database can carry a corrupted native handle — fresh construction per attempt is load-bearing
- Worker main() is synchronous: use Bun.sleepSync, never an un-awaited promise

### Test notes

Unit (db.test.ts or a new fast-tier file): transient-then-success open (mock/stub the failure by preparing against a table created mid-retry, or inject via a wrapper seam) → succeeds; always-failing → throws after N attempts with backoff observed; prepareStmts:false → stmts access throws stub; caller options preserved across attempts. bun run test:full mandatory.

## Acceptance

- [ ] All 12 sites pass prepareStmts:false + bootRetry; main unchanged; events-ingest untouched
- [ ] Retry encloses the full open span, fresh Database per attempt, sync backoff, rethrows after exhaustion
- [ ] isTransientBusyError untouched; new classifier used nowhere outside openDb
- [ ] WorkerSpy/ALL_WORKERS tests still pin 13; bun run test:full green

## Done summary
Added openDb bootRetry knob (bounded transient-boot-class retry, fresh Database per attempt, sync backoff, rethrows after exhaustion) + isTransientBootOpenError classifier private to openDb; swept prepareStmts:false + bootRetry across all 12 worker openDb sites (main and events-ingest untouched). Added db.test.ts coverage; test:full green.
## Evidence
