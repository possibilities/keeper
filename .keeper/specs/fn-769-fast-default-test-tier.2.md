## Description

**Size:** M
**Files:** test/server-worker.test.ts, test/collections.test.ts, test/rpc-handlers.test.ts, test/restore-worker.test.ts, test/view-shell.test.ts, test/keeper-watch.test.ts, test/subagent-invocations.test.ts, test/usage-worker.test.ts, test/transcript-worker.test.ts, test/compaction.test.ts, test/refold-progress.test.ts, test/integrity-probe.test.ts, test/backup.test.ts, test/commit-work-foundation.test.ts

### Approach

Sweep the fast-tier test files whose `beforeEach` (or per-test bodies) run `openDb` and swap to the task-.1 helper. The central per-file decision: `freshMemDb()` when every connection in the test is the one the helper returns; `freshDbFile(path)` when a SECOND connection/Worker/subprocess opens the same DB path (a `:memory:` clone is connection-private). Known file-variant cases: collections.test.ts (beforeEach seeds a path, test bodies re-open it repeatedly — the canonical case) and any server-worker test whose body hands `dbPath` to a spawned Worker/subprocess (those few tests may simply keep real `openDb` — judgment call per test; the win is the ~100 direct-call tests). Do NOT touch: db.test.ts (tests the migration ladder itself), git-worker.test.ts (hand-built mock schema via raw `new Database`, not openDb), the slow-tier daemon/integration files (their cost is daemon boots, not migrations). Tests asserting on migration side effects or `reducer_state.updated_at` freshness keep real openDb — read before swapping, don't regex-replace blindly.

### Investigation targets

**Required** (read before coding):
- test/helpers/template-db.ts — the task-.1 contract (mem vs file variant semantics)
- test/collections.test.ts:39-46 and :310+ — the multi-reopen pattern needing freshDbFile
- test/server-worker.test.ts:1-110 — direct-call layer setup vs the few real-Worker/socket tests
- test/keeper-watch.test.ts — NOTE: carries in-flight fn-766 working-tree changes; rebase on top of whatever fn-766 lands, do not clobber

**Optional** (reference as needed):
- test/rpc-handlers.test.ts:45-60 — disk-path beforeEach, likely freshDbFile
- test/restore-worker.test.ts, test/view-shell.test.ts — straight mem-variant candidates

### Risks

- A test that opens a second connection expecting the first's rows will pass with file variant and silently see an EMPTY db with mem variant — when in doubt, file variant (still ~30x cheaper than migrate).
- fn-766 / fn-767 overlap on keeper-watch.test.ts / server-worker.test.ts — coordinate via the epic deps already wired.

### Test notes

Each adopted file green solo and in the full `--parallel` run. Expect solo improvements roughly: server-worker 6.4s → ~3s, collections 2.5s → ~1s, rpc-handlers/restore-worker/view-shell each well under 1s.

## Acceptance

- [ ] Every adopted file green solo AND under full `bun run test`
- [ ] No test deleted or semantically weakened (same assertion counts per file)
- [ ] server-worker.test.ts <4s solo; collections.test.ts <1.5s solo
- [ ] `bun run lint` and `bun run typecheck` pass

## Done summary
Adopted the fn-769 template-DB clone helper across 13 fast-tier unit suites (freshMemDb for single-connection, freshDbFile for shared-path multi-connection), and fixed freshDbFile to establish WAL on disk so readonly re-openers can attach. Solo wins: server-worker 6.4s->~3.8s, collections 2.5s->~0.9s, restore-worker 6.4s->0.5s, rpc-handlers 4.8s->0.3s; all green under full bun run test (2773/0), lint+typecheck clean.
## Evidence
