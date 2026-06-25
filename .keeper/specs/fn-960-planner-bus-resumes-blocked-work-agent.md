## Overview

The blocked-worker escalation loop is one-way today: a `/plan:work` agent that hits an unresolvable blocker stamps `keeper plan block` and stops, keeperd escalates once to `planner@<epic>` with a "NO reply needed, do not reply" directive, and after the planner unblocks the board the autopilot cold-re-dispatches a FRESH worker — discarding everything the still-live worker already figured out. In reality the blocked `/work` session is usually still alive (idle, its `keeper bus watch` inbox armed). This epic makes the planner **resume the still-live worker in-context** the PRIMARY path: after resolving the blocker and `keeper plan unblock`, the planner bus-messages the worker's live session (addressable `work::<task>`) to resume; autopilot cold-re-dispatch becomes the FALLBACK for a genuinely dead worker. The work is a coordinated rewrite of the daemon escalation directive plus the planner/worker/README prose so every surface tells one consistent PRIMARY(bus-resume)/FALLBACK(cold-re-dispatch) story.

## Quick commands

- `bun test test/daemon.test.ts` — directive-body + block-escalation sweep tests
- `keeper prompt render-plugin-templates --project-root "$(pwd)"` — regenerate managed skill/agent files
- `cd plugins/prompt && bun test` — parity + check_generated for the regenerated tree (NOT covered by keeper test:full)
- `grep -rn "NO reply needed\|do not reply\|no warm resume\|cold-re-dispatches a fresh worker" src/ plugins/ README.md` — should return nothing after the change

## Acceptance

- [ ] Every surface (daemon directive, planner skill, work skill, worker agent, README) describes the same PRIMARY bus-resume / FALLBACK cold-re-dispatch loop — no stale "do not reply / cold-re-dispatch only" instance left behind.
- [ ] No new reducer/RPC write path; double-dispatch safety rests on the existing live-pane occupancy gate, documented not re-engineered.
- [ ] Managed files regenerated from templates; check_generated/parity + `bun run test:full` green.

## Early proof point

Task that proves the approach: `.1` — the `daemon.test.ts` directive-body assertion flipping from "NO reply needed" to the `keeper bus chat send work::<task>` resume instruction is the first green signal. If the directive can't be expressed cleanly, the wording needs rethinking. If it fails: re-derive the directive body shape before touching the prose surfaces.

## References

- Verified mechanics: `src/daemon.ts:557` `buildBlockEscalationBody`, `:4383` `notifyPlannerOfBlock`; `src/autopilot-worker.ts:266` (`work::<task>` `--name`), `:866` `isOccupyingJob` (live-pane gate suppresses cold-re-dispatch while the pane lives); bus result tokens `cli/bus.ts:766-847`, `sendResultIsSuccess` `:822`; README block-escalation narrative ~L3011-3028; verdict-gated window-reaper README ~L433-438.
- Two transports — do NOT conflate: (1) keeperd→`planner@<epic>` bus escalation; (2) planner→`work::<task>` bus resume reaching the `/plan:work` ORCHESTRATOR session, which then uses its intra-session `SendMessage(worker_agent_id)` warm-resume to continue the inner subagent.
- Overlap (advisory, fn-959 worktree-capable-autopilot): it rewrites `src/autopilot-worker.ts` and the autopilot README/CLAUDE section — keep this epic's autopilot work READ-ONLY and edit only the block-escalation README narrative to avoid a conflict.
