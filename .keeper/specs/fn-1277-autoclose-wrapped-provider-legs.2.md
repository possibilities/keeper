## Description

**Size:** M
**Files:** src/agent/main.ts, src/agent/run-capture.ts, src/agent/dispatch.ts, test/agent-run-capture.test.ts, test/agent-run-capture-golden.test.ts, test/agent-launch-config.test.ts, plugins/plan/template/_partials/worker-implement-wrapped.md, plugins/prompt/test/parity.test.ts, docs/install.md, docs/plugin-composition-map.md

### Approach

Treat explicit `--session` and `--name` values on `keeper agent run --resume` as launch presentation while preserving the rule that the resumed Harness session owns its model, effort, and preset. Thread those two presentation fields through the existing shared LaunchPosture seam so every wrapped iteration recreates or rejoins `wrapped` and receives the bare task-ID title.

Rewrite the wrapped-worker template consistently: fresh launch, cold recovery prose, duplicate-leg checks, and feedback iteration use `<task-id>` as display/lookup text, while waiting uses the run handle, continuation uses the captured Harness resume target or exact resolved session, and cleanup remains daemon-owned. Correct any prose claiming that the provider process itself closes the resident tmux window. Update operational and composition docs by consolidating their current behavior descriptions.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/agent/main.ts:1473-1505` — fresh-run LaunchPosture handling for session and name.
- `src/agent/main.ts:1603-1774` — resume resolution and the empty posture that currently discards parsed presentation fields.
- `src/agent/run-capture.ts:286-352` — parser contract separating session grouping, title, resume, and one-shot reap posture.
- `src/agent/launch-config.ts:232-265` — shared session/name argv composition across harnesses.
- `plugins/plan/template/_partials/worker-implement-wrapped.md:24-47` — authoritative fresh launch, cold recovery, wait, and iteration contract.
- `plugins/prompt/test/parity.test.ts:899-938` — rendered wrapped-cell behavior assertions.

**Optional** (reference as needed):
- `test/agent-run-capture.test.ts:1606-1706` — existing resume cwd, harness, and transcript identity fixtures.
- `test/agent-run-capture-golden.test.ts:114-227` — exact agent-run argv golden coverage.
- `test/agent-launch-config.test.ts:700-760` — harness-specific resume composition.
- `docs/install.md:10-25` — current autoclose operations paragraph to consolidate.
- `docs/plugin-composition-map.md:70-115` — wrapped-cell topology description.

### Risks

Bare task IDs are duplicateable display titles and cannot replace the run handle, exact tmux window identity, or Harness resume target. Passing session/name through resume must not weaken the existing rejection of model/effort/preset overrides. The template must not add `--reap-window-on-terminal`, because a chunk-level timeout can still represent a running provider.

### Test notes

Pin resume argv for at least Pi and one other Harness, including `--session wrapped --name <task-id>` while retaining native resume identity and recorded cwd. Render a wrapped cell in-process and assert bare launch/resume references, absence of `wrapped::<task-id>`, and absence of unsafe one-shot reaping. Keep panel and generic resident-run goldens unchanged.

### Detailed phases

1. Thread parsed session/name presentation through resume launch posture without admitting model/effort/preset overrides.
2. Replace every prefixed provider-leg title/reference in the wrapped template with the bare task ID and align lifecycle prose with daemon autoclose.
3. Update parser/resume/golden and rendered-template parity coverage.
4. Consolidate install and plugin-composition documentation around the accepted provider-leg lifecycle.

### Alternatives

Automatically inheriting prior tmux topology inside generic resume was rejected because Tmux placement is not Harness identity and callers may intentionally choose a different presentation. The wrapped contract supplies explicit placement on each turn.

### Non-functional targets

Preserve argv separation without shell interpolation, cross-harness launch parity, existing resume cwd and identity semantics, and race-safe recreation of a missing shared Tmux session.

### Rollout

New turns use bare task-ID titles immediately. Resume lookup remains compatible with durable Harness IDs; legacy-prefixed stopped windows are handled by task 1's classifier rather than by retaining the prefix in new launches.

## Acceptance

- [ ] `keeper agent run --resume` honors explicit session and name presentation while continuing to reject model, effort, and preset overrides.
- [ ] Fresh and resumed wrapped provider legs launch into `wrapped` with a bare task-ID tmux/Harness title.
- [ ] Waiting, exact cleanup, and Harness continuation remain keyed by run handle, exact tmux identity, and resume target rather than title.
- [ ] The rendered wrapped-worker contract contains no `wrapped::<task-id>` reference and does not use one-shot reap behavior for chunked runs.
- [ ] Generic resident runs and panel one-shot cleanup retain their existing behavior.
- [ ] Current operational and plugin-composition docs describe the shared-session, resume, title, and autoclose contract without historical narration.

## Done summary
Threaded --session/--name presentation through keeper agent run --resume launch posture (model/effort/preset still rejected), rewrote the wrapped-worker template to bare task-ID titles keyed by run handle and Harness resume target with no wrapped::<task-id> or one-shot reap, added Pi/Codex resume argv golden coverage plus rendered-template parity assertions, and consolidated docs/install.md + docs/plugin-composition-map.md around the shared-session/autoclose contract.
## Evidence
