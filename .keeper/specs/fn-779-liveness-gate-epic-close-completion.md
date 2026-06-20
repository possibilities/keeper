## Overview

An epic's close row currently reaches the terminal `completed` readiness verdict on `epic.status === "done"` alone, while the closer agent and its subagents may still be winding down — releasing the per-epic/per-root mutexes, unblocking downstream dep-on-epic items, and authorizing the completion reap against a still-live pane. This epic gates close-row completion behind the same close-scope liveness clauses the task path already uses (no working job, no running subagent, no live monitor lease) and makes downstream dep-on-epic satisfaction liveness-aware in the readiness pass. End state: "complete" means done AND idle, everywhere the autopilot reads it.

Deliberate policy (human-confirmed): no new TTL/ceiling escape hatch. The wedge backstops are the existing ones — the exit-watcher Killed arm for the main close job, the monitor release ceiling, and the sub-agent-stale pill + autopilot pause/manual replay for silent subagent orphans. Correctness over throughput, mirroring the task path.

## Quick commands

- bun test test/readiness.test.ts   # fast-tier readiness verdicts (task .1)
- bun run test:full                  # mandatory gate — task .2 touches the slow tier

## Acceptance

- [ ] A close row with `status='done'` and live close-scope work (working job / running subagent / live monitor) renders `running:*`, keeps occupying the per-epic and per-root mutexes, and only flips `completed` once idle
- [ ] A downstream task whose `resolved_epic_deps` entry reads `satisfied` stays `blocked:dep-on-epic` while the in-snapshot upstream has live close-scope work; out-of-snapshot and cross-project upstreams keep today's behavior
- [ ] The completion reap fires only after the close row is done AND idle (inherited via the narrowed verdict — no reap-side code change)
- [ ] Reducer-side `resolved_epic_deps` stamping and `epic-deps.ts` resolution stay status-only and untouched
- [ ] `bun run test:full` passes

## Early proof point

Task that proves the approach: ordinal 1 (close-row predicate gating + dep-on-epic liveness, fast-tier tests). If it fails: the fall-through interaction with predicates 5/6/6.6 or the order-independent upstream pooling is wrong — re-examine against the task-path mirror at src/readiness.ts:733-740 before touching docs or the slow tier.

## References

- `fn-776` (overlap, deliberately NOT a dep edge) — comment/CLAUDE.md squeegee whose tasks .4/.6 touch src/readiness.ts and src/autopilot-worker.ts. Decision: this epic lands first; the squeegee absorbs the new prose. All comment edits here follow the agreed conventions: rewrite to present-tense invariant, zero ticket ids in comments, delete tombstones on touch, no new CLAUDE.md paragraph; the readiness predicate RANK ORDER comment and the autopilot cooldown ordering-chain comment (ceilingMs < PENDING_DISPATCH_TTL_MS < REDISPATCH_COOLDOWN_S) stay intact.
- src/readiness.ts:733-740 — task-path predicate 1, the pattern being mirrored
- test/readiness.test.ts:1779-1803 — load-bearing out-of-snapshot `satisfied` test that must keep passing unmodified

## Docs gaps

- **README.md:2139-2151**: update — completion-reap prose claims close completion is status-only and carries the "deliberately does NOT gate on is_exited" rationale; the verdict now encodes idle
- **README.md:697-698**: update — Board UI `dep-on-epic` description: clears only once the upstream is done AND idle
- **docs/exec-backend.md:224-226**: prune — same stale is_exited rationale; keep "durable verdict is the sole authorization"
- **CLAUDE.md (Autopilot, completion reap)**: update — at most one line: liveness gating for the close-row verdict lives in src/readiness.ts, not reap-side

## Best practices

- **Gate terminal verdicts on every liveness surface, not just the status column:** the "status says done but process still alive" race is the canonical orchestrator TOCTOU; K8s Jobs (sidecar-never-exits) and Temporal (completion = handler return, not signal) both separate status-written from process-exited [K8s Pod Lifecycle docs; Temporal community]
- **Every liveness-gated wait needs an escape that does not depend on the waited-on process:** here deliberately the existing backstops (Killed arm, monitor ceiling, stale pill + manual replay) rather than a new TTL ceiling — a conscious correctness-over-throughput call mirroring the task path [Amazon SWF timeout taxonomy; Temporal HeartbeatTimeout]
- **Let the single ordered reconcile cycle serialize the completion fan-out** (mutex release, dependent unblock, reap) instead of letting consumers read the projection at different times [Restate, "every system is a log"]
- **Happy-path cost is bounded:** the gate adds at most one reconcile cycle of latency when the closer exits cleanly; only crash cases ride the backstops
