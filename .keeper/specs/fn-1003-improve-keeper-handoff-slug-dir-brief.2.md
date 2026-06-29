## Description

**Size:** M
**Files:** cli/handoff.ts, src/rpc-handlers.ts, src/server-worker.ts, src/daemon.ts, src/reducer.ts, src/db.ts, src/collections.ts, src/handoff-worker.ts, keeper/api.py, test/reducer-projections.test.ts, test/handoff.test.ts, test/handoff-worker.test.ts

### Approach

Add `--dir <path>` to `keeper handoff` to launch the handoff-ee into a chosen directory,
defaulting to the initiator agent's cwd. The CLI resolves `--dir` (expand `~`, resolve a
relative path against the CLI's own `process.cwd()` = the caller's cwd) to an ABSOLUTE
path, validates it exists and is a directory (mirror dispatch's `dirExists` → exit 2 on
miss), and ALWAYS sends a `target_dir` field (resolved absolute path; default =
`process.cwd()`). Thread `target_dir` through: the `request_handoff` RPC param (+ a
daemon-side absolute-path guard), the `HandoffRequested` event data, a NEW nullable
`handoffs.target_dir TEXT` column (schema bump 95->96 via `addColumnIfMissing`, NO
DEFAULT, re-fold-safe, NO cursor rewind; add 96 to `SUPPORTED_SCHEMA_VERSIONS` in
keeper/api.py in the SAME commit + a forward-facing comment paragraph), the
`foldHandoffRequested` UPSERT, the `collections` `columns[]` read, `selectActionableHandoffs`'
SELECT, and the worker launch cwd — which becomes PER-ROW (`row.target_dir ?? data.cwd ??
process.cwd()`, coalescing empty-string -> global BEFORE the spawn) since `dispatchOneHandoff`
currently passes one worker-global cwd for all rows.

### Investigation targets

**Required** (read before coding):
- cli/dispatch.ts:135,230,240 — the `--cwd` / `target_repo` / `dirExists` parity template (exit-2-on-cwd-missing)
- cli/handoff.ts:93 — `buildRequestHandoffFrame` (+ `target_dir`); arg parsing
- src/db.ts:49 — `SCHEMA_VERSION = 95` (→96); :1268-1283 `handoffs` CREATE (add `target_dir TEXT`); :1980 `addColumnIfMissing`; :5410-5445 the v94/v95 ladder pattern to mirror
- keeper/api.py:386 — `SUPPORTED_SCHEMA_VERSIONS` (+96) + the comment block :362-385 (add a forward-facing vNN paragraph)
- src/reducer.ts:4578-4695 — `extractHandoffRequestedPayload` + `foldHandoffRequested` INSERT/UPSERT (add `target_dir`)
- src/collections.ts:760-782 — `handoffs` `columns[]` (add `target_dir`)
- src/handoff-worker.ts:329 — `selectActionableHandoffs` (add `target_dir` to SELECT); :425/:511-519/:569 the worker-global cwd → per-row plumbing to `agentwrapLaunch`
- src/exec-backend.ts:1082-1086 — cwd set on the spawn (agentwrap has no `--cwd` flag)
- src/rpc-handlers.ts:548,585 — `validateRequestHandoffParams` (+ `target_dir`, `optStr`); src/server-worker.ts:3462-3484 bridge message
- src/daemon.ts:2838-2846 — the event `$data` JSON (add `target_dir`)

### Risks

- Schema migration is forward-only + version-guarded; bump `SCHEMA_VERSION` AND `SUPPORTED_SCHEMA_VERSIONS` in the SAME commit (test/schema-version.test.ts enforces). The `target_dir` add needs NO cursor rewind and is re-fold-safe (pre-v96 event → NULL).
- The worker cwd must become per-row; leaving the worker-global cwd launches every handoff-ee in keeperd's cwd.
- Empty-string `target_dir` must coalesce to the global cwd BEFORE the spawn (exec-backend treats `""` as undefined → keeperd cwd).
- TOCTOU: the dir can vanish between enqueue and launch. CLI upfront validation is the primary guard; OPTIONALLY classify a spawn-cwd ENOENT at the worker as a clean terminal `HandoffLaunchFailed` rather than the blanket `retryable` that burns the K=3 never-bound breaker (include only if cheap).

### Test notes

- test/reducer-projections.test.ts:5884-6010 — extend the `handoffRequestedEvent` helper + `getHandoffs` to carry/assert `target_dir`; assert the zero-event projection AND a pre-v96 (no `target_dir`) event folds to NULL byte-identically.
- test/schema-version.test.ts — passes with 96 whitelisted.
- test/handoff-worker.test.ts:195 — `dispatchOneHandoff` asserts the per-row `target_dir` wins as launch cwd; null → global fallback.
- test/handoff.test.ts — `buildRequestHandoffFrame` carries `target_dir`; CLI exits 2 on a missing `--dir`.

## Acceptance

- [ ] `keeper handoff --dir <path>` launches the handoff-ee with that dir as cwd; `--dir` defaults to the initiator's cwd; a non-existent / non-directory path → exit 2.
- [ ] The CLI resolves `~` and relative paths (against the caller's cwd) to an ABSOLUTE path before sending; the daemon guards the absolute-path shape.
- [ ] A new nullable `handoffs.target_dir` column lands via a forward-only v95->v96 migration; `SCHEMA_VERSION=96` and keeper/api.py `SUPPORTED_SCHEMA_VERSIONS` includes 96 in the SAME commit.
- [ ] `target_dir` flows event → fold → projection → collection → worker; the worker launch cwd is per-row (`row.target_dir ?? data.cwd ?? process.cwd()`).
- [ ] Re-fold of a pre-v96 (no `target_dir`) event yields `target_dir` NULL byte-identically; `foldHandoffRequested` stays a pure UPSERT.
- [ ] `bun test` green (incl. schema-version + the new column tests).

## Done summary
Added keeper handoff --dir to launch the handoff-ee in a chosen directory (default: caller's cwd), resolved+validated CLI-side and threaded event->fold->nullable handoffs.target_dir (schema v95->v96)->collection->per-row worker launch cwd.
## Evidence
