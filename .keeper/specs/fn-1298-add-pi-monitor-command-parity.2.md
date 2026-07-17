## Description

**Size:** M
**Files:** plugins/keeper/pi-extension/keeper-events.ts, test/pi-extension.test.ts, test/reducer-projections.test.ts, test/refold-equivalence.test.ts

### Approach

Bind the command-monitor controller into the tracked Pi extension without widening its isolation boundary. Register the shared `Monitor` facade and generic exact-id stop surface fail-open, then deliver monitor line batches and terminal outcomes through Pi custom messages using `deliverAs: "steer"` and `triggerTurn: true`. The injected text must carry the same automated-background-task framing as Claude notifications so models never mistake a monitor event for a human reply; terminal notices include status, exit/timeout detail, task id, description, and the private output artifact reference.

Preserve the task id in the Pi tool result `details` so the existing `PostToolUse:Monitor` provenance path can bind it. On each Pi Stop-equivalent event, snapshot-replace the controller's live tasks as shell entries with `kind: "monitor"`, command, and description, alongside the existing Agent Bus child as `kind: "ambient"`; never let ambient-only children consume worker occupancy. Session replacement, reload, fork, new, resume, and quit fence delivery first and await controller teardown before releasing the extension instance.

Reuse existing reducer and await semantics rather than adding a Pi branch: the same projected `jobs.monitors` data must make exact `cmd:` and `kind:monitor` selectors observable to `keeper await monitor-running`. Keep the shared await/watch skills unchanged unless integration proves the existing contract text itself false.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `plugins/keeper/pi-extension/keeper-events.ts:525` — Pi tool-result translation and Stop payload construction.
- `plugins/keeper/pi-extension/keeper-events.ts:1283` — safe custom-message injection seam for idle and busy turns.
- `plugins/keeper/pi-extension/keeper-events.ts:1307` — current Bus inbox/controller construction and tracked-session gate.
- `plugins/keeper/pi-extension/keeper-events.ts:1379` — session-start and every-reason session-shutdown lifecycle wiring.
- `src/derivers.ts:196` — `PostToolUse:Monitor` task-id provenance contract.
- `src/derivers.ts:280` — bounded, stable Stop background-task snapshot contract.
- `src/derivers.ts:356` — `monitor`/`bash-bg` occupancy versus `ambient` non-occupancy.

**Optional** (reference as needed):
- `test/pi-extension.test.ts:769` — tracked registration, fail-open factory, lifecycle, and ambient snapshot fixtures.
- `test/reducer-projections.test.ts:7398` — monitor snapshot/provenance/refold contract coverage.
- `plugins/keeper/skills/await/SKILL.md:163` — harness-neutral Monitor usage that must remain true without edits.

### Risks

Returning a task id but dropping it from event details makes the monitor look ambient and breaks occupancy semantics. Emitting plain user-like text can satisfy pending questions accidentally. Session replacement invalidates old Pi APIs before all child callbacks settle, so teardown order and generation fencing are load-bearing. Snapshot replacement must include both native monitors and the existing Bus inbox or one source will erase the other.

### Test notes

Extend fake Pi API tests to assert registration only for tracked sessions, automated-not-user line and terminal injection, exact result details, snapshot union/classification, and teardown on every replacement reason. Feed emitted envelopes through existing deriver/reducer fixtures to prove stable bytes and unchanged `monitor-running` selector behavior.

## Acceptance

- [ ] Tracked Pi registers the shared command-mode Monitor and exact-id stop surface; missing or throwing extension APIs leave the session usable without a partial controller.
- [ ] Monitor creation returns the same task id carried by later automated line/terminal notifications and `PostToolUse:Monitor` provenance.
- [ ] Every Stop snapshot includes live tool monitors as `monitor` and the existing Agent Bus child as `ambient`, with stable ordering and snapshot-replace semantics.
- [ ] Session replacement and shutdown prevent stale delivery, stop every monitor process tree within the bounded ladder, and preserve the existing Bus inbox teardown.
- [ ] Existing Keeper projection/occupancy logic recognizes Pi monitors and `keeper await monitor-running` selectors without source changes or harness-specific skill prose.
- [ ] Focused extension, projection, and refold suites pass.

## Done summary
Wired the shared command-mode Monitor into the tracked Pi extension: fail-open registration, automated batch/terminal notifications via steer delivery, task-id provenance threaded into PostToolUse:Monitor, Stop snapshot union of live monitors (kind:monitor) and the Agent Bus child (kind:ambient), and shutdown fencing that stops every live monitor before teardown.
## Evidence
