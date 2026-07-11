## Description

**Size:** S
**Files:** plugins/plan/src/verbs/overlap_sweep.ts (new), plugins/plan/src/edit_claims.ts, the plan CLI verb registry module, plugins/plan/test/saga-overlap-sweep.test.ts (new)

### Approach

A read-only verb `keeper plan overlap-sweep <epic_id>` that intersects the target
epic's claims against every other OPEN epic's claims — the deterministic replacement
for the planner eyeballing same-session sibling portfolios. It reads .keeper state
directly (so an epic scaffolded seconds ago is visible — no commit dependency),
scopes comparisons to task pairs resolving to the same repo, reuses the exact
claims-module verdict from the gate, and emits an envelope splitting hard hits
(expected same-kind exact — the wire-a-dep tier) from soft hits (the advisory tier),
each naming the epic, the task pair, and the colliding claim. The verb performs NO
writes and NO auto-commit: acting on hits (epic add-deps for hard, a References note
for soft) stays with the calling skill — detection and action deliberately separate
seams.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/edit_claims.ts — the pair-verdict function the sweep reuses (built by the prior task; do not fork the matrix)
- plugins/plan/src/verbs/selection_brief.ts — the read-heavy verb shape (envelope discipline, state loading) to mirror
- plugins/plan/src/state_path.ts — the single data-dir seam every read routes through

**Optional** (reference as needed):
- plugins/plan/src/verbs/scaffold.ts — how open epics and task JSON are enumerated today

### Risks

- Legacy epics without claims must sweep as vacuously clean (their tasks have no claims to intersect) — absence is not an error
- Cross-project boards: sweep only epics whose resolved repos intersect the target's — never compare across unrelated repos

### Test notes

Saga test with two in-tree epics: colliding expected path across epics lands in hard;
glob/possible collision lands in soft; claim-less legacy epic yields empty; envelope
is stable-ordered (deterministic across runs); verb leaves the .keeper tree
byte-identical (no commit minted).

## Acceptance

- [ ] The sweep reports a hard hit for an expected exact collision against another open epic, including one scaffolded in the same session with no commits
- [ ] Soft hits (glob or possible) are reported separately from hard hits; zero-hit boards yield a clean empty envelope
- [ ] The verb is read-only: no .keeper mutation, no auto-commit, stable-ordered output

## Done summary

## Evidence
