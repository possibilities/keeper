## Description

**Size:** S
**Files:** src/protocol.ts (new), src/db.ts, test/protocol.test.ts (new), test/db.test.ts

### Approach

Build the pure, socket-free foundation the server worker stands on, so it can be unit-tested with zero Worker/socket machinery.

1. **`src/protocol.ts` (new)** — the NDJSON wire contract, dependency-free:
   - Frame TypeScript types as discriminated unions. Client→server: `query {type:"query", id?, sort?, limit?, offset?, filter?}`, `unsubscribe {type:"unsubscribe", id?}`. Server→client: `result {type:"result", id?, rev, rows: Job[]}` (doubles as the initial snapshot), `patch {type:"patch", rev, job: Job}`, `error {type:"error", id?, code, message}`. **`rev` is present on every server frame** (= `reducer_state.last_event_id`).
   - `encodeFrame(frame): string` = `JSON.stringify(frame) + "\n"`.
   - A line-buffer de-framer: `extractLines(chunk, prevRemainder) → { lines: string[], remaining: string }` (or a small `LineBuffer` class holding the partial tail). Split on `\n`, retain the partial tail, strip a trailing `\r`. Enforce a **max-line cap (1 MB)** — a remainder that exceeds the cap with no newline is a protocol error the caller surfaces (don't grow unbounded).
   - Match the file-level doc-comment density of the other `src/*.ts` modules.
2. **`src/db.ts`** — add the path resolver + read queries (centralized per repo convention):
   - `resolveSockPath()` sibling to `resolveDbPath()` — reads `KEEPER_SOCK`, override wins; default `~/.local/state/keeper/keeperd.sock`.
   - Two read-only query helpers following the `Stmts`/`prepareStmts` convention: `selectJobsByIds(ids)` (`WHERE job_id IN (...)`) and `selectWorldRev()` (`reducer_state.last_event_id`). Handle the **empty id-set** (no invalid `IN ()` SQL — return `[]` without querying) and stay within the SQLite bind-variable limit (default 999 — the caller chunks or caps; document the assumption).
   - Reuse `Job` / `ReducerState` from `src/types.ts`; do not redefine row shapes.

### Investigation targets

**Required** (read before coding):
- src/db.ts:33 — `resolveDbPath` (the sibling pattern for `resolveSockPath`, `KEEPER_DB` override-wins)
- src/db.ts:179-256 — `Stmts` + `prepareStmts` (prepared-statement convention for the new read queries)
- src/db.ts:73-92 — `jobs` + `reducer_state` schema (columns the queries read; `jobs.last_event_id`, `reducer_state.last_event_id`)
- src/types.ts:46-75 — `Job` / `ReducerState` row interfaces to reuse
- src/wake-worker.ts:1-26 — file-level doc-comment density to match in `protocol.ts`

**Optional** (reference as needed):
- test/db.test.ts — existing env-override + readonly assertion patterns to extend

### Risks

- SQLite `IN (...)` has a bind-variable limit (default 999); an unbounded id-set silently fails — chunk or cap and document.
- Empty id-set must short-circuit to `[]`, never emit `IN ()`.
- The frame types are the downstream contract every later task and every future consumer targets — get field names and the `rev`-on-every-server-frame rule right here.

### Test notes

- `test/protocol.test.ts` (new): framing round-trip; partial-chunk reassembly (one message split across two chunks; two messages in one chunk; trailing `\r` stripped); oversized-line cap triggers a protocol error.
- `test/db.test.ts` (extend): `resolveSockPath` honors `KEEPER_SOCK` and falls back to the default; `selectJobsByIds` with empty set (`[]`, no query) and multi-id; `selectWorldRev` returns the singleton rev.

## Acceptance

- [ ] `src/protocol.ts` exports the frame discriminated unions (query/unsubscribe/result/patch/error) with `rev` on every server frame
- [ ] `encodeFrame` + line-buffer de-framer handle partial / multi / CRLF chunks and cap oversized lines (1 MB)
- [ ] `resolveSockPath()` reads `KEEPER_SOCK`, defaults to `~/.local/state/keeper/keeperd.sock`
- [ ] `selectJobsByIds` (empty + multi-id, within bind-var limit) and `selectWorldRev` added per the `db.ts` statement convention
- [ ] `bun test`, `bun run lint`, `bun run typecheck` pass

## Done summary

## Evidence
