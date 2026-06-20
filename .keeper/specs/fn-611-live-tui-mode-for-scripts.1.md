## Description

**Size:** M
**Files:** src/readiness-client.ts, scripts/git.ts, test/git.test.ts (may add)

### Approach

`subscribeReadiness` in `src/readiness-client.ts:252` is hard-coded to
open three subscriptions (epics + jobs + subagent_invocations) on one
connection and gate first-paint on all three. It owns the reusable
bits we want — capped-backoff reconnect, `LineBuffer` parsing,
`dispose()` lifecycle, steady-poll backstop, lifecycle event
callback — but they're entangled with the three-collection gate and
the `computeReadiness` handoff.

Extract those reusable primitives into a generic
`subscribeCollection({ sockPath, idPrefix, collection, filter?, sort?,
limit?, onRows, onLifecycle, onFatal? })` factory (same file or a
sibling — planner's call; one file preferred to avoid module sprawl).
`subscribeReadiness` then composes three `subscribeCollection` calls
under one connection — same external surface, no behavior change to
`autopilot.ts` or `board.ts`. Then rewrite `scripts/git.ts` to use
`subscribeCollection({ collection: "git", ... })`, deleting its
hand-rolled `Bun.connect`/`LineBuffer`/`reconnectSoon`/`pollTimer`
block (`scripts/git.ts:140-156` state + `:267-301` connect loop +
`:303-309` SIGINT body).

Preserve the `--project-dir` filter (encoded as `{ project_dir }` in
the query frame) and the empty-row drop policy (`aheadCount === 0 &&
dirtyCount === 0 && orphanedCount === 0` rows skipped during render).

After this task, all three scripts subscribe via the same helper, all
three SIGINT bodies become uniform (`handle.dispose()` → exit), and
the live-shell in task 2 has one integration shape to target.

### Investigation targets

**Required** (read before coding):
- `src/readiness-client.ts:252` — `subscribeReadiness` factory, the
  thing being decomposed; the per-collection `makeState` calls + the
  three-collection first-paint gate are the seam.
- `src/readiness-client.ts:111` — `ReadinessSocket` socket-handler
  adapter; reuse for the generic helper.
- `scripts/git.ts:121-312` — the entire current `main()` body; lines
  140-156 + 162-181 (query) + 231-255 (handle) + 257-309 (connect +
  SIGINT) are the migration target.
- `src/protocol.ts` — `QueryFrame`, `ServerFrame`, `LineBuffer`,
  `encodeFrame` (already used by both helpers).
- `test/board.test.ts`, `test/autopilot.test.ts` — test style + the
  in-memory mock socket pattern (look for `connect:` factory
  injection); the generic helper must keep this seam so a `git.ts`
  test can drive it the same way.

**Optional** (reference as needed):
- `src/collections.ts` — collection descriptors; the helper takes a
  bare string `collection` field on the query frame, not a descriptor.
- `scripts/board.ts:233`, `scripts/autopilot.ts:208` — reference
  consumers of `subscribeReadiness`; verify their behavior is
  bit-identical after the refactor.

### Risks

- **Behavior drift in autopilot/board:** the readiness composition
  must call `computeReadiness` at exactly the same point (after all
  three collections have a `result`); a careless extraction could
  re-order this.
- **`emitLifecycle` shape parity:** git.ts already prints
  `...`-fenced lifecycle notes (`scripts/git.ts:291`-ish via
  `console.error`); the migrated path must emit `connecting /
  connected / disconnected / waiting` notes via the helper's
  `onLifecycle` callback the way autopilot+board do — same `...`
  fence format.
- **Patch/meta refetch semantics:** today `git.ts:246-250` refetches
  on `patch` OR `meta`; the helper's per-collection model (see
  `subscribeReadiness`) does the same per-collection. Confirm parity.

### Test notes

- Add a small `test/git.test.ts` (if none exists) that drives the
  new helper with an in-memory mock socket — at minimum, a smoke
  test that a `result` frame produces the expected `string[]` from
  the renderer. Match the `connect:` injection style in the existing
  helper tests.
- Re-run `test/board.test.ts` + `test/autopilot.test.ts` — they
  must pass unchanged (no API surface drift).

## Acceptance

- [ ] `subscribeCollection` (or equivalent generic helper) exists and is exported from `src/readiness-client.ts` (or a sibling file).
- [ ] `subscribeReadiness` is rewritten to compose three `subscribeCollection` calls on one connection; existing consumers (autopilot, board) work unchanged.
- [ ] `scripts/git.ts` no longer calls `Bun.connect` directly — uses the new helper.
- [ ] `scripts/git.ts` SIGINT body collapses to `handle.dispose() → process.exit(0)` like autopilot/board.
- [ ] `--project-dir` filter still works (smoke test: `bun scripts/git.ts --project-dir <some-path>` produces a filtered frame).
- [ ] `bun run lint && bun run typecheck && bun test` pass.

## Done summary
Extracted subscribeCollection from subscribeReadiness behind a shared subscribeMulti driver; rewired scripts/git.ts to use it (deleting its hand-rolled Bun.connect/LineBuffer/reconnect loop and uniformizing SIGINT to handle.dispose()). Added test/git.test.ts covering query-frame shape, first-paint gate, coalesce, idempotent dispose, and renderRowBlocks empty-row drop.
## Evidence
