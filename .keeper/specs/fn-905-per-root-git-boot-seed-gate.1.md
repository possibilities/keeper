## Description

**Size:** M
**Files:** src/git-boot-seed.ts, src/git-worker.ts, src/reducer.ts, test/git-boot-seed.test.ts

### Approach

Three changes to the producer side, no gate restructure (that is task 2):

1. **Scope the boot-seed** to plan-relevant roots. `discoverSeedRoots`
   (`git-boot-seed.ts:119-136`) hard-codes `buildDiscoveryCandidates(...,
   runFullSweep:true)` → `SELECT DISTINCT cwd FROM jobs` (every historical
   cwd) + all epics. Thread the existing fast-path instead (`runFullSweep:
   false` → working/recent jobs) AND ensure every GATED root (open-epic
   `project_dir` + each task `target_repo`, including close-row roots) is in
   the set, so the surface of every root a readiness row can reference is
   established at boot. Drop the stale `/private/tmp` + `/Volumes/Scratch`
   roots. Do NOT alter the git-worker's OWN watched-set call site — it
   shares `buildDiscoveryCandidates` but is a different caller.
2. **Self-clear `seed_required`.** Today it clears only on `complete===true`
   (every root). Change to: clear once all GATED roots seeded (best-effort
   for stale ones) in the boot-seed; AND, for a gated root the boot-seed
   missed/failed, clear it from main's above-floor `GitSnapshot` fold
   (`projectGitStatus`, `reducer.ts:1824`) once every gated root has a
   `git_status` row with `last_event_id > floor`. This is the producer-only
   self-heal — the live git-worker's emit, folded by main, clears the flag;
   the git-worker never writes `git_projection_state`.
3. **Log the silent skip.** `git-boot-seed.ts:268-275` (`readStatus`→null)
   does `complete=false; continue` with NO log; the throw branch
   (`:282-286`) logs. Add a structured `console.error` here naming the root
   (and best-effort reason: timeout vs non-git vs error).

### Investigation targets

**Required** (read before coding):
- src/git-boot-seed.ts:119-136 — `discoverSeedRoots`; :257-298 — seed loop + the `complete`/clear logic; :268-275 — the silent null skip
- src/git-worker.ts:1199-1218 — `buildDiscoveryCandidates` fast-path vs full-sweep; :306 — `RECENT_JOB_WINDOW_MS`
- src/reducer.ts:1824 — `projectGitStatus` (above-floor fold); the skip-floor gate that no-ops folds `id <= floor`
- src/db.ts:1342-1364 — `readGitProjectionSeedRequired`/`setGitProjectionSeedRequired`; :1206-1213 — `git_projection_state`

**Optional** (reference as needed):
- src/await-conditions.ts:692-697 — the rowless-clean inference (why a clean non-.keeper root may have no row)
- test/git-boot-seed.test.ts:223 — clear-on-success; :252/:272/:288 — degrade/throw/budget harness

### Risks

- The fold-side self-clear MUST preserve re-fold determinism: it runs ONLY in above-floor folds (the skip-floor already no-ops historical folds), `seed_required` is charter-excluded control state, and the "all gated roots seeded" check reads only DB projections (no wall-clock/fs/env). Verify against test/refold-equivalence.test.ts.
- "Gated roots" must be derived deterministically from the epics projection (open-epic `project_dir` + task `target_repo`), matching exactly the root set task 2's gate will consult.
- Scoping must not strand a clean, plan-relevant root: it is in the gated set, so the boot-seed mints its row (`insertSyntheticGitSnapshot` folds a snapshot even for a clean root — confirm no early-return-on-clean in `buildGitSnapshot`/`projectGitStatus`).

### Test notes

Extend test/git-boot-seed.test.ts: scoped discovery drops stale roots while keeping every gated root; `seed_required` self-clears once gated roots seed (boot path AND a fold path where one root is seeded only by a later above-floor GitSnapshot); a transiently-failing root leaves only itself unseeded; budget exhaustion still serves. `bun run test:full`.

## Acceptance

- [ ] Boot-seed discovers only plan-relevant roots (open-epic `project_dir` + task `target_repo` + working/recent jobs), not the full historical `jobs.cwd` sweep; every gated root is covered.
- [ ] `seed_required` self-clears once all gated roots are seeded, via the boot-seed AND main's above-floor git fold (no git-worker write, no retry loop).
- [ ] A per-root `readStatus`→null skip is logged with the root.
- [ ] Re-fold byte-identical for deterministic projections (refold-equivalence test passes); no schema change.
- [ ] `bun run test:full` green.

## Done summary
Scoped the git boot-seed to plan-relevant + gated roots (open-epic project_dir + task target_repo), dropping the full historical jobs.cwd sweep; made seed_required self-clear once all gated roots seed via the boot-seed AND main's above-floor GitSnapshot fold (producer-only, no git-worker write); logged the previously-silent readStatus→null per-root skip.
## Evidence
