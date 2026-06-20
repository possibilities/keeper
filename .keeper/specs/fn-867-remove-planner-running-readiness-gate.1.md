## Description

**Size:** M
**Files:** src/readiness.ts, src/icon-theme.ts, src/board-render.ts, src/await-conditions.ts, README.md, test/readiness.test.ts, test/board.test.ts, test/autopilot-worker.test.ts, test/await-conditions.test.ts

### Approach

Remove the `planner-running` readiness gate end to end. In `src/readiness.ts`:
delete predicate 3 in BOTH `evaluateTask` (~544-549) and `evaluateCloseRow`
(~799-802); delete the helpers `anyJobLinkRunning` (~1315-1328) and
`epicWorkStarted` (~1330-1353) — both referenced ONLY by predicate 3; drop the
`{ kind: "planner-running" }` member from the `RunningReason` union (~175);
collapse `isRootOccupant`'s planner exemption (~954-957) to
`return isLiveWorkOccupant(verdict)`, KEEPING the `export` (autopilot-worker.ts
imports it at :51 and calls it at :880,885). Remove the
`"running:planner-running": FA.pencil` entry in `src/icon-theme.ts:97` — the
`running:` prefix catch-all (icon-theme.ts:175) absorbs any stray pill.

The board pills vanish with ZERO `cli/board.ts` logic change: `rollupEpicHeader`
(readiness.ts:1247-1281) passes `reason` through structurally, and `formatPill`
interpolates the kind string — once the verdict is never produced the epic
header / task-row / close-row pills simply fall through to the next-priority
verdict.

Scrub forward-facing doc comments that name `planner-running`: the readiness.ts
header rank-order block (lines ~10-45, esp. 17, 32-34), the inline prose at
~914/927/944/951-952/1316/1331-1341, `board-render.ts:476`, and
`await-conditions.ts:431-433` (prose-only — no code dep). Leave the predicate
numbering gap (no renumber — the pipeline already skips numbers like 1.5, 6.6).
Add a forward-facing comment at predicate 2 (`epic-not-validated`) noting it is
now the primary guard against dispatching a mid-plan / mid-refine epic.

CRITICAL — there is NO TypeScript safety net: removing the union member produces
NO exhaustiveness error (all consumers interpolate `reason.kind`). Run
`grep -rn "planner-running"` across src/, cli/, test/, README.md before AND after,
and run the typecheck to catch any fixture still typed against the dropped member.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:169-175 — `RunningReason` union; drop line 175
- src/readiness.ts:533-549 — predicate 2 (`epic-not-validated`, KEEP + annotate) and predicate 3 (DELETE) in `evaluateTask`
- src/readiness.ts:794-802 — predicate 2/3 in `evaluateCloseRow`
- src/readiness.ts:1315-1353 — `anyJobLinkRunning` + `epicWorkStarted` (delete both, incl. their doc blocks)
- src/readiness.ts:942-959 — `isRootOccupant`: collapse exemption (954-957), keep export
- src/readiness.ts:1247-1281 — `rollupEpicHeader` (structural passthrough — confirm no edit needed)
- src/icon-theme.ts:97, :175 — exact entry + `running:` prefix catch-all
- src/autopilot-worker.ts:51, 880, 885 — `isRootOccupant` callers that must stay green
- test/autopilot-worker.test.ts:1624-1650 — the fn-725 cap test to REWORK (see Risks/Test notes)

**Optional** (reference as needed):
- src/board-render.ts:476 — doc comment
- src/await-conditions.ts:431-433, 666 — prose-only references / `verdictPhrase` interpolation
- README.md ~754, ~2428-2429 — PILL_COLORS + mutex prose

### Risks

- The fn-725 cap test (autopilot-worker.test.ts:1624-1650) asserts a working-planner
  epic is planner-EXEMPT from the per-root cap. That semantic disappears. Repurpose
  the test to assert the working-planner-only validated epic's task now reads `ready`
  and competes for the cap like any worker — rework, do NOT one-line-edit.
- Create-path dispatch window: `scaffold` stamps `last_validated_at` inline, so during
  Phase 6 inter-epic dep-wiring a ready task is briefly dispatchable before cross-epic
  deps land. Narrow (sub-second; yolo + unpaused only; epics WITH inter-epic deps) and
  already closed in `armed` mode. ACCEPTED as the explicit intent — document via the
  predicate-2 comment; do NOT re-add serialization.
- No exhaustiveness error on union-member removal — rely on `grep` + typecheck.

### Test notes

- Delete the planner-running behavioral suite in readiness.test.ts: 230-232
  (isRootOccupant-exempt), 1476, 1558-1572 (the ordering test is DOUBLY stale — its
  loser predicate 4 was already removed by fn-756 — full delete), 2543-2675
  (planner-running / planner-restart block), 3099-3173 (fn-663 per-root close-row/task
  cases), 3283-3284 (formatPill).
- board.test.ts:1162-1172 — drop the `planner-running` line from the colorize case;
  1502-1505 — remove the `PLANNER_RUNNING` fixture and check its downstream uses.
- await-conditions.test.ts:229 — drop the single `planner-running` array element.
- reducer-links.test.ts:3124 — update the now-stale comment (the fold still runs; no
  readiness predicate consumes it), KEEP the test.
- Rework autopilot-worker.test.ts:1624-1650 per Risks.
- `grep -rn "planner-running" src/ cli/` returns zero; run `bun run test:full` (MANDATORY —
  readiness + autopilot dispatch paths are slow-tier).

## Acceptance

- [ ] Autopilot readiness never produces a `running:planner-running` verdict; an epic with a working planner/refiner and a validated, dep-satisfied task reads `ready` for both its task rows and close-row.
- [ ] predicate 3, `anyJobLinkRunning`, `epicWorkStarted`, the `planner-running` `RunningReason` member, and the `icon-theme.ts` entry are removed; `isRootOccupant` collapses to `isLiveWorkOccupant` and stays exported.
- [ ] The `job_links` projection, reducer fold, and `cli/board.ts` `renderJobLinkLines` `[creator]/[refiner] [working]` line are unchanged; no schema migration / SCHEMA_VERSION bump.
- [ ] `grep -rn "planner-running" src/ cli/` returns no hits; the repo typecheck passes.
- [ ] The fn-725 cap test is reworked to assert the new ready-task behavior; all stale planner-running tests are deleted.
- [ ] `bun run test:full` passes.
- [ ] Forward-facing doc comments + README mutex prose naming planner-running are scrubbed; a comment at predicate 2 documents it as the retained mid-plan guard.

## Done summary

## Evidence
