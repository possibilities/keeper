## Overview

The `keeper bus wake` liveness recheck (`creatorIsLive` / `isRunningState` in
`src/bus-wake.ts`) only treats a `working` job as live. A creator that has
`stopped` but whose tmux pane is still live — and that has NOT re-armed
`keeper bus watch` (so it is absent from `liveSessionIds`) — passes both live
signals as "not live" and gets a redundant `claude --resume` double-attach,
the exact hazard the recheck exists to prevent. The autopilot's own occupancy
check (`isStoppedJobLive` in `src/autopilot-worker.ts`) already treats a
`stopped`+live-pane job as occupying; this aligns the wake to that signal.
Blast radius is bounded today by the single-flight lock + cooldown (one stray
resume), so this is a correctness hardening of a guard, not a fire.

## Acceptance

- [ ] The wake liveness recheck treats a `stopped` creator with a live tmux pane as live and SKIPs the resume.
- [ ] A creator that is genuinely gone (no live pane, not on bus) still wakes.
- [ ] The new behavior is unit-tested against synthetic inputs (no real tmux).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | src/bus-wake.ts:124 isRunningState only treats `working` as live; a `stopped`+live-pane creator gets a redundant `claude --resume` the recheck should prevent (cf `isStoppedJobLive` autopilot-worker.ts:822) |
| F2 | culled | — | src/bus-worker.ts:914 replay is namespace-unfiltered but the bus is chat-first; the cross-namespace hazard only exists under unbuilt multi-tenant — speculative, no current impact |
| F3 | culled | — | src/resume-descriptor.ts:65 bare `cwd` interpolation is trusted plan data (not exploitable), pre-existing, shared by three callers — out-of-scope churn |

## Out of scope

- Namespace-membership gating of wake replay (F2) — deferred to whenever multi-tenant namespaces actually land.
- Quoting `cwd` in `buildResumeCommand` (F3) — pre-existing, shared by three callers; left for the next touch of `resume-descriptor.ts`.
- The `claude --resume` SPAWN half of the wake remains un-CI-able and manually verified, as the audit accepted.
