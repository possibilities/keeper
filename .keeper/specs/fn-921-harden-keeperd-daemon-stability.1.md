## Description

**Size:** M
**Files:** src/git-worker.ts, src/git-boot-seed.ts, src/gated-roots.ts, src/readiness.ts, src/db.ts, src/daemon.ts (+ tests)

### Approach

Make the keeperd git surface durable and watcher-independent so it can never
again silently freeze (`seed_required=1`, zero GitSnapshots → `computeReadiness`
forces `{kind:"unknown"}` → autopilot darks all keeper-root dispatch).

1. **Always-on poll producer, decoupled from `@parcel/watcher`.** Today the
   db-poll timer, heartbeat backstop, and rollup are ALL armed *inside* the
   `import("@parcel/watcher").then()` callback after `await reconcileRoots()`
   (`git-worker.ts:2552-2668`). A successful import followed by a post-import
   hang or a mute watcher leaves NO timers armed and NO backstop → the current
   silent freeze. **Arm the poll producer unconditionally at worker start,
   independent of the watcher import.** Poll-only for git: drop the git-worker's
   `@parcel/watcher` subscription (a load failure already crash-restarts via the
   `.catch → process.exit(1)` at `:2670`; we are removing the dependency, not
   that path). Two-tier poll: a cheap `stat()` of `.git` metadata
   (`HEAD`/`index`/`logs/HEAD`/`packed-refs`) + a shallow worktree mtime check
   per gated root at ~300ms; on a detected delta, run the existing git scan +
   `emitSnapshot` (reuse the semantic-dedupe/coalesce gate). Cost is negligible
   (a few hundred `stat()`/sec); latency ~300ms, tunable.

2. **Synced-read barrier for commit-work (a CORRECTNESS requirement, not a
   nicety).** `file_attributions` — which files a session is on-the-hook for —
   is charged ONLY in pass 1 of the GitSnapshot fold (`reducer.ts:1041-1352`,
   `buildExplicitAttribHoist`), by intersecting the promoted `mutation_path`
   events with the GitSnapshot's live-dirty set. `keeper commit-work` reads that
   projection (`src/commit-work/attribution.ts`: undischarged `file_attributions`
   rows ∩ a LIVE `git status`) to decide what to stage. Poll-only WIDENS the
   window in which a file you just edited is live-dirty but NOT yet charged (no
   GitSnapshot since the edit) → commit-work could miss staging it. So provide a
   TARGETED, synchronous "scan-this-repo-now AND await the resulting GitSnapshot
   fold" barrier that commit-work invokes BEFORE its attribution read, so its
   `(attributions, live-dirty)` pair is consistent for that repo regardless of
   the background poll cadence. Scope the immediate scan to the ONE repo (never
   the O(roots) `data_version`→per-root fan-out the team removed for CPU,
   `git-worker.ts:2562-2568`). The barrier MUST fail-open (bounded timeout →
   fall back to the current read) so a wedged producer can never hang
   commit-work. Do NOT move commit-work onto the lagging `git_status` projection
   — its live-`git status` read (`attribution.ts:8-13`) stays. The same scan-now
   mechanism also freshens board/dash + the post-commit dispatch gate.

3. **Clear `seed_required` on a quiet repo + fix the gated-root key mismatch.**
   The heartbeat only emits on a *change*, so a quiet repo with `seed_required`
   set never self-clears. The producer must emit (or the boot-seed must
   complete) so the flag clears even with no file activity. AND reconcile the
   gated-root key mismatch (`gated-roots.ts:98-110`): `unseededGatedRoots` /
   `allGatedRootsSeeded` key on the raw `effectiveRoot` but rows are written
   under `resolveGitToplevel(root)` — a mismatch means a perfectly-emitted
   snapshot still never clears `seed_required`. Normalize the read key to match
   the write key (or normalize at registration). Verify which roots currently
   mismatch.

4. **Boot-seed robustness.** `seedGitProjection` (`git-boot-seed.ts:279-356`)
   leaves `seed_required=1` and serves on a degraded/timed-out per-root scan
   (30s budget). Harden so the keeper root reliably seeds (bounded retry within
   budget, or hand off to the steady-state producer which now actually emits on
   a quiet repo).

5. **Seed liveness watchdog (supervisor-side, `daemon.ts`).** Detect a stuck
   surface — `seed_required` held AND zero GitSnapshot for N minutes — and
   recover: re-arm via the existing `reconcileRoots`/re-seed path FIRST;
   `fatalExit → LaunchAgent restart` only as a capped last resort. Never trip
   during a legitimately in-flight boot-seed; never escalate on a deterministic
   stuck condition (step 3's key-mismatch fix removes the only such case, so the
   watchdog cannot crash-loop). Extract the verdict as a PURE exported helper
   (mirror `decideTranscriptResubscribe`) for unit reach. The current
   supervisor only catches crash/exit (`gw.onerror`/`close → fatalExit`,
   `daemon.ts:2830-2835`), not a silent-but-alive mute — a worker→main liveness
   pulse is the additive signal.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:2552-2682 — the watcher-import `.then`/`.catch`; the producer must move OUT of `.then`
- src/git-worker.ts:2586-2653 — the heartbeat backstop (quiet-repo no-emit gap)
- src/git-worker.ts:1950 — `emitSnapshot` (emits only on a fresh change)
- src/git-worker.ts:2200 — HEAD-divergence `process.exit(1)` escalation precedent
- src/transcript-worker.ts:961 — `decideTranscriptResubscribe` PURE verdict helper (the template for the watchdog/re-arm decision)
- src/git-boot-seed.ts:279-356 — `seedGitProjection` degrade-not-fatal path + `buildSnapshotForRoot` injectable seam
- src/gated-roots.ts:94-137 — `unseededGatedRoots` / `allGatedRootsSeeded` + the key-mismatch invariant comment (:98-110)
- src/readiness.ts:508-528 — `computeReadiness` forces `unknown` for an unseeded `effectiveRoot`
- src/db.ts:1418-1452 — `readGitProjectionSeedRequired` / `setGitProjectionSeedRequired` / `raiseGitProjectionFloor`
- src/daemon.ts:2730-2837 — git-worker spawn + `onerror`/`close → fatalExit` supervision
- src/commit-work/attribution.ts:1-55 — the on-hook read (undischarged `file_attributions` ∩ live `git status`); the consumer whose synced/consistent read T1 must preserve
- src/reducer.ts:1041-1352 — `buildExplicitAttribHoist` (`file_attributions` charged in GitSnapshot-fold pass 1 — the producer-cadence dependency the barrier closes)

**Optional** (reference as needed):
- src/exit-watcher-ffi.ts — the kqueue FFI pattern (NOT used here — poll-only chosen — but the canonical native-addon-free watch precedent if revisited)
- src/wake-worker.ts — the `data_version` poll pump cadence pattern

### Risks

- **Re-fold determinism:** the git surface is LIVE-ONLY / charter-excluded. Any new producer or control state stays out of the re-fold wipe list; the fold reads NO clock/env/fs (producer probes, fold stays pure).
- **Synced-scan flood:** the targeted scan-now MUST stay scoped to the single changed root — a regression to O(roots) fan-out re-creates the original CPU flood.
- **commit-work attribution consistency:** `file_attributions` is git-worker-fed (charged on the GitSnapshot fold), so the synced barrier (fail-open, bounded, single-repo) before commit-work's read is load-bearing — without it, poll-lag can let commit-work stage a stale on-hook set. The barrier must NEVER hang commit-work (timeout → current behavior).
- **Watchdog crash-loop:** never escalate on a deterministic-stuck condition (the key-mismatch fix is load-bearing for this); cap restart escalation; never trip mid-boot-seed.
- **Schema:** a new control column on `git_projection_state` requires a `SCHEMA_VERSION` bump + the version added to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit.

### Test notes

- Extract the poll-decision + watchdog verdict as PURE exported helpers (mirror `decideTranscriptResubscribe` / `decideDataVersionWake`) and unit-test with plain inputs.
- Drive `seedGitProjection` git-free via the `buildSnapshotForRoot` seam with synthetic `GitSnapshotPayload` (the `test/git-boot-seed.test.ts` pattern); golden git strings for any scan parse.
- Real git only in a `*.slow.test.ts` added to `scripts/test-real-git-allowlist.txt`. `bun run test:full` is mandatory.

## Acceptance

- [ ] the poll producer arms unconditionally at worker start and survives a `@parcel/watcher` load-hang / mute (the producer no longer lives inside the watcher `.then`)
- [ ] a quiet repo with `seed_required=1` gets it CLEARED (the producer/boot-seed emits to clear, not only on change)
- [ ] the gated-root write key matches the readiness read key so an emitted snapshot actually clears `seed_required` (verified for the keeper root)
- [ ] `keeper commit-work` reads a CONSISTENT `(file_attributions, live-dirty)` set — a file edited immediately before commit-work is still attributed + staged (the scan-and-await barrier, fail-open + single-repo, closes the poll-lag window and never hangs commit-work)
- [ ] a commit reflects in the changed root's git projection within ~one poll tick, with the immediate scan scoped to that one root (no fan-out)
- [ ] a seed liveness watchdog recovers a stuck surface without a manual bounce, with no crash-loop on a deterministic-stuck and no false trip during boot-seed
- [ ] `computeReadiness` un-darks keeper-root dispatch once seeded
- [ ] `bun run test:full` green

## Done summary

## Evidence
