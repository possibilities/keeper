## Description

**Size:** M
**Files:** cli/autopilot.ts, cli/git.ts, src/autopilot-view.ts, src/git-view.ts, test/autopilot.test.ts, test/git.test.ts

### Approach

Replace Autopilot's split banner plus six optional prose sections with one deterministic YAML model rooted at `autopilot`: durable state/mode/config first, followed by current dispatches, failures, armed epics, worktree state, and dependency information when present. Merge current/stopped dispatch formatting, remove static legends and repeated defaults, and preserve every explicit control verb plus the machine `autopilot show` envelope.

Replace Git's width-budgeted blocks with a YAML model rooted at `git`: repositories sort by canonical project directory; each carries branch/ahead/behind and nonzero dirty/orphan/no-attribution counts plus a complete path-sorted file list and stable provenance entries. Remove lossy line truncation/join-split formatting, align current state with displayed rows, and include behind-only repositories currently filtered out. Both commands remove `--watch` and agent-snapshot advice while retaining finite human snapshots and their existing Frames entries.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/autopilot.ts:342 — pure current/failure/worktree/dependency projectors.
- cli/autopilot.ts:607 — six-section body renderer and repeated dispatch formatting.
- cli/autopilot.ts:987 — five-stream shell integration and banner/state split.
- cli/autopilot.ts:1278 — positional control verbs that must remain independent.
- cli/git.ts:192 — lane/path shortening and width-dependent labels.
- cli/git.ts:243 — clean-row filtering, behind-only edge, attribution truncation, and block renderer.
- cli/git.ts:441 — shared shell subscription and raw state sidecar.
- test/autopilot.test.ts:416 — presentation and banner fixtures.
- test/git.test.ts:343 — layout, truncation, and attribution fixtures.

**Optional** (reference as needed):
- cli/autopilot.ts:530 — machine `show` projection reused by agent control guidance.
- cli/format.ts:17 — repository YAML convention.
- src/git-attribution-floor.ts — provenance semantics that presentation labels must not collapse.

### Risks

Autopilot's banner currently carries fields omitted by its state sidecar; consolidation must preserve caps, provider, paused/mode, and armed semantics without changing controls. Git dirty/orphan/unattributed counts are not interchangeable and file mirrors may be capped upstream; preserve exact scalars rather than recomputing them. Raw branches, paths, and attribution labels are hostile terminal input.

### Test notes

Add structural and exact YAML fixtures with shuffled equivalent inputs and special scalars. For Autopilot cover idle, paused/playing, armed/yolo, caps/provider, current/stopped/failure/worktree/dependency states and prove control/show tests unchanged. For Git cover clean omission, behind-only inclusion, lane/repo identity, renames, exact count meanings, full files, provenance ordering, and no width truncation.

### Detailed phases

1. Define Autopilot presentation model and unify banner/body state.
2. Preserve control/show grammar while removing viewer watch/advice drift.
3. Define Git presentation model with exact count and provenance semantics.
4. Replace bespoke width/truncation rendering and update both fixture suites.

### Alternatives

Serializing raw Autopilot or Git rows is rejected because raw shapes include redundant and capped machine details. Retaining colored pills inside YAML is rejected because post-serialization styling breaks display-as-serialized and complicates terminal safety.

### Non-functional targets

Both serializers are linear in presented input, independent of terminal width/locale, byte-stable under equivalent ordering, and safe against control-sequence injection.

### Rollout

Viewer bodies intentionally change while Autopilot control verbs, `show`, and the Frames envelope remain compatible.

## Acceptance

- [ ] Autopilot emits deterministic YAML rooted at `autopilot` containing durable state/mode/config and every present dispatch/failure/armed/worktree/dependency concern without duplicate legends or banner-only fields.
- [ ] `keeper autopilot pause|play|mode|config|arm|disarm|worktree|retry|show` retain their current control or machine-envelope behavior and tests.
- [ ] Git emits deterministic YAML rooted at `git`, omits clean repositories, includes behind-only repositories, preserves exact nonzero count meanings, and renders complete file/provenance lists without width truncation.
- [ ] Git ordering is stable by project, path, and provenance identity/recency, and hostile paths/branches/labels remain valid terminal-safe YAML.
- [ ] Both commands reject `--watch`, contain no agent-facing snapshot recommendation, and share their presentation with live, finite snapshot, current sidecar, and Frames paths.
- [ ] Autopilot and Git presentation tests pass while their subscription/control contracts remain green.

## Done summary

## Evidence
