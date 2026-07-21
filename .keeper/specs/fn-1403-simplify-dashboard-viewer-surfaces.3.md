## Description

**Size:** M
**Files:** cli/jobs.ts, src/jobs-view.ts, test/jobs.test.ts

### Approach

Replace Jobs' text rows and expansion/insert state with a pure deterministic presentation model serialized under the `jobs` YAML root. Every job exposes backend pane, monitors, subagents, scheduled tasks, awaits, lane, state, and telemetry when present; empty optional fields disappear, complete lists remain uncapped, and redundant role/title/default-pill prose is removed.

Establish total ordering before serialization: named session groups sort by canonical session identifier with no-session last; working jobs sort before stopped jobs, then by project, title, and durable job id; nested monitors, subagents, and scheduled tasks use their durable identity/key with stable timestamp tie-breakers. Delete replay RPC, tmux focus, selection, expansion, and local repaint key wiring from the viewer; inherited current-frame scrolling and Ctrl-C remain.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/jobs.ts:173 — current pure job-row telemetry projection.
- cli/jobs.ts:343 — expansion/selection render options.
- cli/jobs.ts:383 — session grouping and first-seen ordering.
- cli/jobs.ts:455 — hidden backend/monitor/subagent/scheduled detail rendering.
- cli/jobs.ts:751 — replay, focus, insert, selection, and expansion key handlers.
- cli/jobs.ts:949 — shared shell and readiness-subscription wiring.
- test/jobs.test.ts:639 — expansion and insert-mode fixtures to replace.

**Optional** (reference as needed):
- cli/format.ts:17 — existing YAML rendering convention.
- src/dash/view-model.ts:246 — pure deterministic presentation-model pattern.
- plugins/prompt/src/yaml_dump.ts:1 — canonical YAML serializer options.

### Risks

Nested wire data may be malformed or partially absent; the projector must degrade one field/record without dropping unrelated jobs. Full lists can be tall, so serialization must stay compact while preserving scrolling and every requested detail. Removing replay/focus keys must not remove any separate explicit CLI control surface.

### Test notes

Replace collapse/selection fixtures with structural and exact YAML fixtures. Cover all formerly hidden detail classes, empty Jobs, malformed nested data, duplicate-looking titles, hostile YAML/control scalars, full uncapped lists, stable sorting under shuffled input, scroll-only shell behavior, and the Frames entry using the same presentation.

### Detailed phases

1. Define the ordered Jobs presentation types and serializer.
2. Project every detail category by default with explicit malformed-data handling.
3. Remove expansion, selection, replay, pane-focus, and local repaint state.
4. Replace help and test fixtures with the human-only current-view contract.

### Alternatives

Rendering the existing raw readiness snapshot is rejected because it leaks machine shape and retains redundancy. Keeping collapsed state with an expanded default is rejected because it preserves unnecessary interaction and presentation branches.

### Non-functional targets

Output is byte-stable under equivalent shuffled inputs, complete-list rendering is linear in input size, and untrusted titles/commands cannot inject terminal control sequences or YAML structure.

### Rollout

Jobs frame bodies intentionally change for both humans and Frames consumers, but the machine envelope and cursor semantics remain unchanged.

## Acceptance

- [ ] Jobs emits deterministic human-oriented YAML rooted at `jobs`, with working-before-stopped stable ordering and no dependence on first-seen wire order.
- [ ] Backend pane, monitors, subagents, scheduled tasks, awaits, lane, state, and telemetry appear by default whenever present; lists are complete and uncapped.
- [ ] No expansion, disclosure, selection, insert, replay RPC, tmux pane-focus, copy, or frame-history path remains in Jobs; current-frame scrolling and Ctrl-C still work through the shared shell.
- [ ] Empty and malformed optional details degrade predictably without hiding unrelated jobs or producing invalid YAML.
- [ ] Equivalent shuffled inputs and hostile scalars produce byte-stable, terminal-safe output in live, snapshot, current sidecar, and Frames paths.
- [ ] Jobs tests pass with the old interaction fixtures removed rather than disabled.

## Done summary

## Evidence
