## Description

**Size:** M
**Files:** cli/await.ts, src/await-conditions.ts, test/await.test.ts, test/await-conditions.test.ts

Extend the `keeper await` CLI and its pure predicate module to support two
new condition families (`git-clean`, `agents-idle`) and AND-combinations,
while keeping single `complete`/`unblocked` behavior byte-identical. Also
update the `HELP` constant in `cli/await.ts` (it lives in this file).

### Approach

1. **Pure layer (`src/await-conditions.ts`, stays I/O-free).** Widen the
   condition model from `condition: "complete" | "unblocked"` to a
   discriminated union that also carries `git-clean` and `agents-idle`
   (these take NO planctl id — `classifyTargetId` only applies to the
   planctl families). Add two pure predicates fed explicit injected rows:
   - `git-clean`: given the cwd's git root + the `git_status` rows, MET
     when the row for that root has `dirty_count==0 AND orphaned_count==0`
     (the strict `orphaned_count` column, NOT `unattributed_to_live_count`).
     **No row for the root → MET (clean)** — a repo absent from the
     membership-gated `git_status` projection has no dirty/orphan facts.
   - `agents-idle`: given the cwd's git root + the caller's own
     `session_id` + the `jobs` rows, MET when no OTHER job
     (`job_id !== ownSessionId`) with `state==="working"` has a cwd inside
     the root. **Zero such jobs → MET (idle).** cwd containment mirrors
     `src/reducer.ts:1854`: `cwd === root || cwd.startsWith(root + "/")`
     (trailing-slash normalized). These return the existing `AwaitState`
     union (`met`/`waiting`; no `deleted`/`stuck` semantic for git/jobs).
2. **Grammar (`cli/await.ts` parser).** The current `parseArgs` strict
   path asserts exactly 2 positionals — replace with a segment tokenizer:
   split positionals on the literal `and` token into per-condition
   segments, parse each segment's condition + (optional) id, then parse
   the shared flags (`--timeout`/`--json`/`--sock`/`--fail-on-stuck`/
   `--no-armed-line`/`--require-transition`) once for the whole
   invocation. `git-clean`/`agents-idle` take no positional arg;
   `complete`/`unblocked` take exactly one id. Reject empty / duplicate /
   malformed segments with a usage error (exit 1).
3. **Runner (`cli/await.ts` `runAwait`).** Generalize the single-stream
   loop to N latched condition slots (level-triggered, booted explicitly
   to `not-yet-met`). Open ONLY the subscriptions the active conditions
   need: `subscribeReadiness` iff any `complete`/`unblocked` segment is
   present; `subscribeCollection("git")` iff any `git-clean`;
   `subscribeCollection("jobs")` iff any `agents-idle`. (First check
   whether the `subscribeReadiness` snapshot already exposes raw
   `git`/`jobs` rows — if so a planctl-bearing combo can read git/jobs off
   the one snapshot and skip the extra subscribe; otherwise compose
   separate streams.) An **aggregate first-paint gate** holds the `armed`
   line + first eval until every opened subscription has first-painted.
   On each snapshot/rows callback, update that family's slot and call ONE
   shared `evaluate()`; emit terminal `met` only when ALL slots are
   simultaneously met. Re-seed socket-sourced slots on `disconnected` and
   don't re-fire until post-reconnect first paint re-lands (generalize the
   existing `postReconnectStable` per-slot). The planctl families keep
   their existing `deleted`/`stuck`/re-query machinery; do NOT graft it
   onto git/jobs.
4. **Aggregate terminal semantics.** Any planctl sub-condition going
   `not-found`/`deleted`/`stuck`(under `--fail-on-stuck`) short-circuits
   the whole process via the existing `terminating` latch with that
   reason. `--timeout`/SIGTERM apply to the aggregate (exit 3). Preserve
   all exit codes (0/1/3/4/5).
5. **Side-effect reads (`cli/await.ts` `main`/`runAwait`, NOT the pure
   module).** Resolve cwd→git root via a local one-shot
   `git rev-parse --show-toplevel` (do NOT import the module-private
   `resolveGitToplevel` from `git-worker.ts`); on no git root emit a
   terminal `failed reason=no-git-root` exit 1 at arm time. Read
   `CLAUDE_CODE_SESSION_ID` once at startup for self-exclusion (no-op if
   unset). Pass the resolved root + own session id into the pure predicate
   as inputs.
6. **Line protocol.** A single `complete`/`unblocked` invocation MUST emit
   byte-identical `armed`/`met`/`failed` lines (`target=`/`kind=`/
   `condition=`/`state=`) and exit codes. For git/jobs and for
   multi-condition invocations, use a generalized line that names each
   condition (e.g. `condition=git-clean`, and for an aggregate a summary +
   which condition a `failed` came from). Keep `sanitizeValue`,
   flush-before-exit, and the single-`armed`/single-terminal contract.
   Update the `HELP` constant: `Usage` line shows the `and` grammar;
   `Conditions` block adds `git-clean`/`agents-idle`.

### Investigation targets

**Required** (read before coding):
- cli/await.ts:207 `parseAwaitArgs` — the fixed-2-positional parser to replace with the segment tokenizer.
- cli/await.ts:369 `runAwait` + :461 `reQueryHit`/`reQueryHitTask` — the single-stream runner and the one-shot `subscribeCollection` pattern to reuse.
- cli/await.ts:66 `HELP` constant — update in place.
- src/await-conditions.ts:401 `evaluateAwaitCondition`, :206 `AwaitState`, :100 `AwaitTarget`, :118 `classifyTargetId` — the types to widen.
- src/readiness-client.ts:1123 `subscribeCollection` + `SubscribeCollectionOptions`; :1240 `subscribeReadiness` + its snapshot shape (check whether it exposes raw git/jobs rows); :435 `projectGitStatusByProjectDir`; :405 `projectRows`.
- src/collections.ts:374 `GIT_DESCRIPTOR` (dirty_count/orphaned_count), :87 `JOBS_DESCRIPTOR` (filters.cwd exact-match on the wire; defaultFilter hides ended/killed — so subscribe with no cwd filter and do prefix containment in JS).
- src/reducer.ts:1854 cwd containment; :18 and :7062 job state machine (confirms no between-turn flap — agents-idle reads state directly).
- test/await.test.ts — `makeMockConnect()`/`MockSocket.deliver`/`resultFrame(collection,id,rows,rev)`/`subId = ${idPrefix}-${collection}`/`RunDeps` harness. test/await-conditions.test.ts — inline fixture + assert-AwaitState pattern.

**Optional** (reference as needed):
- src/git-worker.ts:600 `gitOutput`/:635 `resolveGitToplevel` — the `--no-optional-locks` + timeout spawn discipline to mirror for the one-shot root resolve (do not import).
- cli/git.ts:308 — canonical `subscribeCollection({collection:"git", filter:{project_dir}})` consumer.

### Risks

- **Glitch / premature-met in the AND gate.** Use level-triggered latched
  slots + one shared `evaluate()` after every callback; never scatter the
  AND across per-stream handlers. Boot slots explicitly to not-met and
  gate the first eval on all-subscriptions-painted, or a slow stream that
  never emits hangs the AND.
- **Orphan-metric choice is load-bearing.** Plan uses strict
  `orphaned_count`. If git-clean should instead mirror autopilot's
  dispatch gate it would need the client-computed
  `unattributed_to_live_count` (`projectGitStatusByProjectDir` math) — a
  deliberate, human-confirmed default; leave a comment noting the swap point.
- **Backward-compat surface.** The legacy single-condition line shape and
  exit codes are an external contract (Monitor consumers, the skill). Pin
  them with the existing tests untouched; only add new tests for the new
  shapes.
- **`subscribeReadiness` raw-row exposure unknown.** If the readiness
  snapshot doesn't surface raw git/jobs rows, separate `subscribeCollection`
  streams are mandatory — verify early (it drives the runner shape).

### Test notes

- Pure predicates (test/await-conditions.test.ts): inline `git_status` and
  `jobs` fixtures → assert `git-clean`/`agents-idle` `AwaitState`,
  including no-row→MET, zero-jobs→MET, self-exclusion, cwd-prefix
  containment (in-root vs sibling-dir false match), and dirty/orphan
  non-zero → waiting.
- Runner (test/await.test.ts): extend `makeMockConnect` with `git`/`jobs`
  result-frame helpers keyed by `await-<pid>-git` / `await-<pid>-jobs`;
  drive an AND of two families and assert `met` fires only after BOTH
  paint+hold; assert a planctl-sub-condition `deleted` short-circuits the
  aggregate; assert the aggregate first-paint gate; assert the legacy
  single-condition path is byte-identical.
- Grammar: unit-test the segment tokenizer (`and` splitting, arity per
  condition, dup/empty/unknown-condition rejection).

## Acceptance

- [ ] `git-clean` predicate: MET when `dirty_count==0 AND orphaned_count==0` for the root; no row for the root → MET; non-zero either count → waiting.
- [ ] `agents-idle` predicate: excludes `job_id === ownSessionId`; MET when no other `state="working"` job has cwd inside the root (prefix containment); zero matching jobs → MET.
- [ ] Pure module has zero new I/O / `Date.now()` reads; cwd-root + session-id + subscriptions all live in `cli/await.ts`.
- [ ] Grammar parses `<c1> and <c2> [and <c3>]`, enforces per-condition arity, rejects empty/dup/unknown segments (exit 1).
- [ ] Runner opens only the subscriptions its conditions need, gates first eval on all-painted, and emits a single terminal `met` only when all slots hold.
- [ ] Planctl sub-condition `not-found`/`deleted`/`stuck`(under flag) short-circuits the aggregate; `--timeout`/SIGTERM → exit 3 for the aggregate.
- [ ] No-git-root → `failed reason=no-git-root` exit 1 at arm time.
- [ ] Single `complete`/`unblocked` invocation: byte-identical lines + exit codes (existing tests pass unmodified).
- [ ] `HELP` updated; `bun test test/await.test.ts test/await-conditions.test.ts` green.

## Done summary

## Evidence
