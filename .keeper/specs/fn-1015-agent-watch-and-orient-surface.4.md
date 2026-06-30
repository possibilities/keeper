## Description

**Size:** M
**Files:** src/await-conditions.ts (new predicates), cli/await.ts (new arity bucket + slots), cli/watch.ts (new), cli/keeper.ts, test/await-conditions.test.ts, test/await.test.ts

The board-change-detection surface: new block-until conditions plus a
streaming tail, all built on client-side snapshot diffing.

### Approach

New await conditions as pure predicates over the (task-1 extended) snapshot,
reusing the existing presence + scope-exempt re-query machinery and the frozen
exit taxonomy (0/1/3/4/5 — do NOT renumber):
- `drained` (nullary, board-wide): `met` when the open board is empty OR every `perTask`/`perCloseRow` verdict is `completed` AND no `pendingDispatches` AND no running jobs — AND `catching_up===false` (never report drained mid-catch-up). Deferred-on-upstream-merge epics (`computeDeferredEpicIds`) count as `waiting`, not drained (self-resolving). `--fail-on-stuck` → `stuck` (exit 5) when a jam-reason sticky is present: allowlist `worktree-finalize-non-fast-forward` + `worktree-merge-conflict`, EXCLUDING the `worktree-recover*` auto-clear prefix (`src/autopilot-worker.ts:429`).
- `epic-added [id]` / `epic-removed <id>` (edge-triggered): diff the epic-id set across ticks; carry a per-slot baseline (first-paint snapshot) in a new `SlotState` variant. These can NEVER be satisfied on first paint (no prior tick) — block until the first qualifying delta. `epic-removed` distinguishes done-transition vs true delete via the existing re-query (mirror `complete`/`deleted`).
- `changed` (nullary, edge-triggered): `met` on the next board delta (scoped to epics + verdicts + autopilot, ignore noisy git_status/subagent churn). Optional `since:R` anchor on a client-side content hash.

New arity handling in `cli/await.ts:243-256` (a board-wide nullary bucket for `drained`/`changed`; an optional-id bucket for `epic-added`/`epic-removed`) and new slot variant(s) in the `:629-791` slot machine carrying the baseline hash. For nullary board conditions, `not-found` (exit 1) is N/A — they have no target.

`keeper watch --json`: a non-exiting NDJSON tail over `subscribeReadiness`
(reconnect-forever, intentional). Hash successive snapshots client-side; emit
a baseline full-snapshot line first, then one coarse delta line per real change
(epic added/removed, verdict change, job-state change, autopilot mode/pause
change). Each line `{schema_version, sequence, type, data}` (`sequence` = per-
process counter). Suppress null-diff lines (reconnect re-paint is byte-identical
→ no delta). Coalesce ~75ms. Idle keepalive line carrying the current `sequence`.
`--filter <type>` is a named-type allowlist (no free-form eval). Register in
cli/keeper.ts (3-touch).

### Investigation targets

**Required** (read before coding):
- cli/await.ts:243-256 (arity buckets), :629-791 (slot machine + stream-routing flags), :733-741 (server-up first-paint precedent for `watch` baseline)
- src/await-conditions.ts — the pure-predicate seam (`evaluateAwaitCondition` + helpers); add the new predicates here, no I/O
- src/readiness.ts:358-379 (Verdict union + ReadinessSnapshot maps)
- src/autopilot-worker.ts:429 (`worktree-recover*` auto-clear prefix), :1877-1916 (`computeDeferredEpicIds` — the deferred set for the drained `waiting` carve-out), dispatch_failures jam reasons
- cli/keeper.ts:22-47/:50-95/:161-191 (register `watch`)

### Risks

- `drained` on bare first paint during catch-up would false-fire exit-0; the `catching_up` guard is load-bearing.
- `watch` reconnect re-paints the full snapshot; without diff-against-last-known every reconnect emits a spurious full delta. Anchor on the last-known hash, not connection lifecycle.
- Edge-triggered conditions conflict with the "exit 0 if already satisfied" default — these intentionally block for the first delta; document the exception.

### Test notes

Pure fixtures: drained empty/all-completed→met; running present→waiting; catching_up→waiting; jam sticky + `--fail-on-stuck`→stuck; recover* sticky→NOT stuck; epic-added on a new id across two snapshots→met; epic-removed done-vs-delete. A pure diff-function test for `watch` deltas (feed two snapshots, assert the delta lines; null-diff→no line). Keep the diff + predicate logic in pure exported functions.

## Acceptance

- [ ] `await drained` (strict, catching_up-guarded, deferred→waiting) + `--fail-on-stuck` jam allowlist (excludes `worktree-recover*`).
- [ ] `await epic-added [id]` / `epic-removed <id>` / `changed` work as edge-triggered predicates with a per-slot baseline; reuse the frozen exit taxonomy.
- [ ] `keeper watch --json` emits baseline + coarse deltas, suppresses null-diffs, coalesces, keepalives, `--filter` named-type allowlist; never exits.
- [ ] Pure fixture/diff tests cover the predicates and the delta function; `bun test` green.

## Done summary
Add board-level await conditions (drained/changed/epic-added/epic-removed) as pure snapshot predicates plus the non-exiting keeper watch NDJSON delta tail; drained --fail-on-stuck jam allowlist excludes worktree-recover*.
## Evidence
