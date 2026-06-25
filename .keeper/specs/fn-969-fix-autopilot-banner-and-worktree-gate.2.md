## Description

**Size:** M
**Files:** cli/autopilot.ts, test/autopilot.test.ts, README.md

### Approach

Two changes to the autopilot viewer / control surface, bundled because both edit
`cli/autopilot.ts` + `test/autopilot.test.ts` (one task avoids a dep edge).

**Gate re-scope (`assertNoMidEpicDispatch`, cli/autopilot.ts:805-834).** Replace the
`Promise.all([queryCollection "jobs", queryCollection "pending_dispatches"])` check with a
single `queryCollection(sockPath, "epics")` (pass NO filter — the descriptor's default
`default_visible = 1` scope serves only open epics; ANY explicit filter drops that clause,
`src/collections.ts:219-228`). Gate on `isEpicStarted(epic)` (`src/readiness.ts:115`,
null-safe + pure). Cast rows `as unknown as Epic[]` — `queryCollection` decodes the
`tasks`/`jobs`/`job_links` JSON columns at the read boundary, so the nested fields
`isEpicStarted` needs are real arrays. Die only when at least one started open epic exists,
enumerating the started epic ids in the message. PRESERVE fail-closed: a transport error
still dies and suggests `--force`. Add a `query` DI parameter (defaulting to `queryCollection`)
so the gate is unit-testable without a daemon — mirrors the existing `die` DI seam; update
the sole call site (cli/autopilot.ts:1043). Add `isEpicStarted` to the existing
`../src/readiness` import (:33) and `Epic` to the `../src/types` import (:44). Rewrite the
doc-comment (:792-803), the die message, and the HELP lines (:81, :94) forward-facing — no
"was/now" narration. Revise the README worktree `--force` guard prose (~lines 3177-3179) in place.

**Per-root banner segment.** Add `projectMaxConcurrentPerRoot(rows)` mirroring
`projectMaxConcurrentJobs` (cli/autopilot.ts:307) but resolving NULL / empty rows /
non-positive-int INSIDE the projection to `DEFAULT_MAX_CONCURRENT_PER_ROOT` (= 1, import from
`../src/db`) — it always returns a concrete `number`, never `null` (NULL means default 1 here,
not unlimited). Add `maxConcurrentPerRoot: number` to `ViewerState` (:547), seed it `1` in the
seed object (:607-621). Project it in `pausedHandle.onRows` (:747-749). Thread it through
`bannerState()` (:668-680), `persistentBannerPill` (:634-641), and `autopilotBannerLabel`
(:578-600) as a REQUIRED param (so the compiler forces every golden-string test to update).
Render `· per-root N` ALWAYS, positioned between the `max N` cap and the worktree segment:
`[playing] · yolo · max 3 · per-root 2 · worktree:off`. Do NOT add per-root to the snapshot
`stateJson` (:655) — no production consumer. Update the README banner-segment enumeration
(~line 1091) to add `per-root` and mention the worktree-mode state.

### Investigation targets

**Required** (read before coding):
- cli/autopilot.ts:805-834 — `assertNoMidEpicDispatch` (rewrite) and :1043 — the sole call site
- cli/autopilot.ts:307-318 — `projectMaxConcurrentJobs` template
- cli/autopilot.ts:547-563, :607-621 — `ViewerState` + seed object
- cli/autopilot.ts:634-641, :668-680 — `persistentBannerPill` + `bannerState()` (thread per-root through BOTH)
- cli/autopilot.ts:725-754 — `pausedHandle` re-projection (:747-749 add per-root)
- cli/autopilot.ts:578-600 — `autopilotBannerLabel` (add required param + segment)
- cli/autopilot.ts:81, :94, :792-803 — HELP + doc-comment to rewrite forward-facing
- src/readiness.ts:115-133 — `isEpicStarted`
- src/db.ts:216 — `DEFAULT_MAX_CONCURRENT_PER_ROOT`
- cli/control-rpc.ts:175 — `queryCollection` (`limit:0`, decodes JSON columns)
- src/collections.ts:219-228 — `epics` default-scope clause (pass NO filter)

**Optional** (reference as needed):
- test/autopilot.test.ts:693-972 — projection + `autopilotBannerLabel` golden-string test patterns
- src/types.ts:739 — `Epic` interface
- README.md ~1091 (banner segments), ~3177 (worktree `--force` guard prose)

### Risks

`autopilotBannerLabel` has ~8 full-string golden tests (test/autopilot.test.ts:879-972); the
required new param breaks all of them at the type level — update every one in lockstep. The
`epics` query MUST pass no filter (any filter drops the open-scope default clause). Adding the
`query` DI param changes the exported `assertNoMidEpicDispatch` signature — only one caller.

### Test notes

Gate test injects a fake `query` returning hand-built `Epic[]` rows: started → dies,
unstarted-open → allows, empty board → allows, transport-error → dies. Fast tier, no daemon.
`projectMaxConcurrentPerRoot` unit test: empty → 1, NULL → 1, 0 / negative / non-int → 1,
positive int → that value. Update all `autopilotBannerLabel` golden strings to carry the new
`per-root N` segment. Run `bun run test:full` (touches the CLI + daemon-adjacent query path).

## Acceptance

- [ ] `worktree <on|off>` requires `--force` ONLY when a started open epic exists (isEpicStarted); drained / unstarted-open / zero-epic board toggles freely; transport error fails closed
- [ ] Gate die message enumerates the started epic ids; doc-comment + HELP + README guard prose rewritten forward-facing
- [ ] `assertNoMidEpicDispatch` takes an injectable `query` param; gate unit test added (started/unstarted-open/empty/transport-error) and green, fast tier
- [ ] Banner always renders `· per-root N` between `max N` and the worktree segment; `projectMaxConcurrentPerRoot` defaults NULL/empty/invalid → 1
- [ ] All `autopilotBannerLabel` golden-string tests updated in lockstep; `projectMaxConcurrentPerRoot` unit test added
- [ ] README banner-segment enumeration updated (per-root + worktree-mode mention); `bun run test:full` green

## Done summary

## Evidence
