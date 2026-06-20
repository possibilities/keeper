## Description

**Size:** M
**Files:** src/db.ts, src/readiness.ts, src/autopilot-worker.ts, src/daemon.ts, test/config.test.ts, test/autopilot-worker.test.ts, test/readiness.test.ts

### Approach

Add `max_concurrent_jobs` to keeper config and enforce it as a global
reconcile-level dispatch budget. This task delivers the working cap with
NO UI — the value is read on main and threaded to the worker via
`workerData`, exactly like `zellijSession`.

1. **Config (src/db.ts):** add `maxConcurrentJobs?: number | null` to
   `KeeperConfig`; add `export const DEFAULT_MAX_CONCURRENT_JOBS = null`
   (unlimited). In `resolveConfig()` parse `max_concurrent_jobs` accepting
   a POSITIVE INTEGER only (`typeof === "number" && Number.isInteger(v) &&
   v > 0`); anything else (0, negative, fractional, string, null, absent)
   stays `null`. Thread the value through ALL THREE return sites
   (early `existsSync` return, catch fallback, final return) following the
   independent-key discipline — a bad `max_concurrent_jobs` must never
   disturb sibling keys.
2. **Export predicate (src/readiness.ts):** `export` the existing private
   `isRootOccupant` (the planner-EXEMPTING occupant predicate). Do NOT
   change its logic — fn-721 extended the canonical occupant set and this
   budget MUST inherit it unchanged.
3. **Thread to worker:** add `maxConcurrentJobs?: number | null` to
   `AutopilotWorkerData`; in `src/daemon.ts` worker spawn (~:2241-2251)
   pass `apConfig.maxConcurrentJobs`; in the worker `main()` (~:1210) read
   `data.maxConcurrentJobs ?? null` into `ReconcileState` (add the field
   to the `{paused, inFlight}` interface at ~:356). `reconcile()` stays
   pure — the cap rides `state`, never a module global.
4. **Budget gate (src/autopilot-worker.ts `reconcile()`):** after the
   existing `computeReadiness` call, count `occupied` ONCE =
   number of verdicts satisfying `isRootOccupant` over BOTH
   `readiness.perTask.values()` AND `readiness.perCloseRow.values()`.
   Compute `budget = cap === null ? Number.POSITIVE_INFINITY :
   Math.max(0, cap - occupied)`. Guard BOTH push sites: task push gets
   `if (budget <= 0) continue;` before `launches.push`; close-row push
   adds `&& budget > 0` to its `okToPlan`. Decrement `budget--` after each
   successful push. The cap is the LAST gate (after every per-task /
   per-epic / per-root verdict is computed) so debug verdicts aren't
   masked. The count is the snapshot baseline; the decrement tracks ONLY
   newly-planned launches — a `dispatch-pending` row is counted as an
   occupant but is already suppressed from re-push by the existing
   `liveTabKeys`/`isOccupyingJob` arms, so it never double-consumes.

### Investigation targets

**Required** (read before coding):
- src/db.ts:147-263 — `KeeperConfig`, `resolveConfig()`, `DEFAULT_AUTOCLOSE_WINDOWS` template, the three return sites, `resolveConfigPath()` test seam.
- src/autopilot-worker.ts:755-858 — `reconcile()`, the five existing suppression arms, the two push sites (task ~:820-827, close-row ~:845-852), `computeReadiness` call (~:765).
- src/autopilot-worker.ts:356-359 — `ReconcileState`; ~:1008 `AutopilotWorkerData`; ~:1210 `main()` state build.
- src/readiness.ts:1404-1445 — `isLiveWorkOccupant` / `isRootOccupant`; :634-635 — `computeReadiness` mutex order (count runs over POST-mutex verdicts).
- src/daemon.ts:2240-2251 — `resolveConfig()` + `apConfig.zellijSession` workerData threading template.

**Optional** (reference as needed):
- src/autopilot-worker.ts:681-695 — `verbForVerdict` (occupancy ≠ dispatchability; count independent of it).
- test/config.test.ts — `KEEPER_CONFIG` temp-YAML seam, env restore pattern.

### Risks

- **Double-counting / off-by-one:** if the count and the per-push decrement both act on the same `dispatch-pending` row the cap under-admits. Keep count = baseline, decrement = newly-pushed only. Test cap=2/occupied=2 → zero launches; planner occupant must NOT consume budget.
- **Predicate drift:** counting with `isLiveWorkOccupant` instead of `isRootOccupant` would charge planners against the cap. Use the exact exported `isRootOccupant`.
- **Independent-key regression:** a malformed `max_concurrent_jobs` must not strand sibling config keys at defaults — test the independence explicitly.

### Test notes

- test/config.test.ts: `max_concurrent_jobs: 3` → `3`; `0` / `-1` / `2.5` / `"x"` / absent → `null`; malformed value leaves a sibling key (e.g. `zellij_session`) intact.
- test/autopilot-worker.test.ts: cap=2 with 2 root-occupants → `launches: []`; cap=2 with 1 occupant + 2 ready → exactly 1 launch; a `planner-running` occupant does NOT consume budget; cap=null → identical to pre-change dispatch; budget shared across task + close-row push sites (a closer can't blow the cap).
- test/readiness.test.ts: convert the existing prose `isRootOccupant` assertions to direct unit calls now that it's exported.

## Acceptance

- [ ] `resolveConfig()` parses `max_concurrent_jobs` as positive-int-only, else `null`, threaded through all three return sites, independent of sibling keys.
- [ ] `isRootOccupant` is exported with unchanged logic.
- [ ] Cap threaded daemon → workerData → `ReconcileState`; `reconcile()` stays pure.
- [ ] `reconcile()` admits at most `cap - occupied` new launches per cycle, counting `isRootOccupant` over perTask ∪ perCloseRow, planners exempt, both push sites guarded by one shared decrementing budget, `budget > 0` strict.
- [ ] `cap === null` reproduces pre-change dispatch behavior exactly.
- [ ] New + existing tests pass (`bun test test/config.test.ts test/autopilot-worker.test.ts test/readiness.test.ts`).

## Done summary
Added max_concurrent_jobs config (positive-int-only, default null=unlimited) and a reconcile-level dispatch budget: reconcile() counts isRootOccupant verdicts over perTask + perCloseRow once, then admits at most cap-occupied new launches across both push sites via one shared decrementing budget (strict budget > 0). Cap threaded daemon -> workerData -> ReconcileState; isRootOccupant exported with unchanged logic; null cap reproduces pre-change dispatch via a POSITIVE_INFINITY fast-path. No UI.
## Evidence
