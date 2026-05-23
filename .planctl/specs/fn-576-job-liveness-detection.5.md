## Description

**Size:** S
**Files:** src/collections.ts, test/server-worker.test.ts

### Approach

Change `JOBS_DESCRIPTOR.defaultFilter` at `src/collections.ts:76-115` from `{ state: { ne: "ended" } }` to `{ state: { not_in: ["ended", "killed"] } }`. Update the surrounding comment block (~lines 102-108) to reflect the four-state vocabulary and the new default-hide list. Hard dep on task 4 (the `not_in` operator must exist on the wire).

### Investigation targets

**Required** (read before coding):
- `src/collections.ts:76-115` — `JOBS_DESCRIPTOR` definition + `defaultFilter`
- `src/collections.ts:102-108` — comment block describing exhaustive state set

**Optional**:
- `scripts/keeper-frames.ts` — confirms default-scope view behavior (no code change needed here, but verify the rendered output matches expectations after this lands)

### Risks

Old clients that explicitly send `filter:{state:{ne:"ended"}}` retain old semantics (killed rows still visible) — that's intentional opt-in, not a regression. New default-scoped clients see only working+stopped, which is the desired outcome of the entire epic.

### Test notes

Update existing defaultFilter test to assert against the new shape. Add a test verifying a query with no explicit `state` filter excludes both ended AND killed rows. Run keeper-frames manually post-merge to confirm the visible behavior change.

## Acceptance

- [ ] defaultFilter on JOBS_DESCRIPTOR uses `{ state: { not_in: ["ended", "killed"] } }`
- [ ] Comment block updated to four-state vocabulary
- [ ] Test verifies default-scoped queries exclude both terminal states
- [ ] Existing explicit `{state:{ne:"ended"}}` queries still resolve

## Done summary
Tightened JOBS_DESCRIPTOR.defaultFilter to {state:{not_in:["ended","killed"]}} so the default jobs view hides both terminal states. Updated comment block to four-state vocabulary and added a runQuery test verifying default-scoped queries exclude ended AND killed.
## Evidence
