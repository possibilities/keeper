## Description

**Size:** M
**Files:** the board renderer (README.md `## Architecture` ~832-894 documents it; find the render source), plugins/keeper/skills/await/SKILL.md (+ the await condition logic in src/)

Make the autopilot-paused resume gap visible (the biggest risk: with autopilot paused, a planner unblocks but nothing re-dispatches, and the human may not notice). Render the escalated-blocked state distinctly and teach `keeper:await` to treat escalated-but-paused as a `waiting` state.

### Approach

- **Board:** read the `block_escalations` projection (task 2) and render a blocked-task that has been escalated distinctly from a plain blocked task (e.g. a `blocked·escalated` pill vs `blocked`), so the human can see "escalation pending / planner notified." Find the board render source (README `## Architecture` ~832-894 points at it).
- **keeper:await:** when a task is blocked AND has an escalation latch AND the autopilot is paused (so cold re-dispatch can't fire), `keeper await unblocked <task>` / `complete <epic>` should report `waiting` (escalation in flight) rather than treating the stall as terminal — so an armed await visibly holds instead of silently never firing. Update the await condition logic + the skill's condition table/examples with the escalated-but-paused case.
- Forward-facing doc updates only.

### Investigation targets

**Required** (read before coding):
- README.md ~832-894 — board rendering description; trace to the render source.
- plugins/keeper/skills/await/SKILL.md — the condition table + examples (the escalated-but-paused gap).
- src/readiness.ts:849-865 — the `runtime-blocked` verdict (how blocked surfaces today); the autopilot-paused signal source.
- the `block_escalations` projection from task 2 (status column) — the escalated signal.

**Optional:**
- plugins/keeper/skills/autopilot/SKILL.md — paused-state semantics.

### Risks

- Over-coupling the board/await to the latch's internal `status` values — read it as a coarse "escalated yes/no," not the full state machine.
- This is the lowest-priority task; if board internals are gnarlier than expected, the `keeper:await` waiting-state is the higher-value half — land that first.

### Test notes

Unit-test the await condition's escalated-but-paused branch with synthetic projection state (blocked + latch + paused → waiting; blocked + latch + unpaused → not-waiting/ready-soon). Board render: a render snapshot/unit test if the renderer has one; otherwise a synthetic-state assertion. `bun run test:full`.

## Acceptance

- [ ] The board renders an escalated-blocked task distinctly from a plain blocked task.
- [ ] `keeper:await` reports `waiting` for a blocked+escalated task while the autopilot is paused, instead of treating it as terminal/never-firing.
- [ ] await condition table/examples document the escalated-but-paused case.
- [ ] `bun run test:full` green.

## Done summary
Surface escalated-but-paused blocked tasks: keeper:await softens an escalated runtime-blocked task from stuck to waiting while the autopilot is paused (so an armed --fail-on-stuck wait holds for the planner), and the board renders [blocked:escalated] distinctly from [blocked:runtime-blocked]. Subscribed block_escalations + autopilot paused onto the readiness snapshot.
## Evidence
