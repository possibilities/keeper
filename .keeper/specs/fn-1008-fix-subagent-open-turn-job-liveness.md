## Overview

The board shows a plan job as `[::stopped]` while its backgrounded worker subagent is
genuinely in flight (and the subagent renders a false `[::ok]`), because subagent liveness
is keyed on a `status='running'` column that `PostToolUse:Agent` flips to `'ok'` at spawn
time. This epic replaces the scattered `status='running'` checks with ONE canonical
"open turn" definition — `duration_ms IS NULL AND status IN ('running','ok')` — across the
two reducer guards (Stop + ApiError/RateLimited), the orphan sweep, and the readiness layer.
The reducer guards re-base their 120s freshness bound from the frozen SubagentStart spawn
`ts` onto last-activity `updated_at`; the readiness layer is deliberately left unbounded so
a slow-but-alive subagent (a long Bash/build freezes `updated_at`) is never re-dispatched.
SILENT_STREAM_CUT stays byte-for-byte untouched.

## Quick commands

- `bun test` — the whole pure-in-process suite green (it is the integration safety net for this fold-invariant change)
- `rg "status = 'running'" src/` — only the supersession scan (`findOpenRunningInGroup`) and the `SubagentStart` INSERT seed remain; no liveness guard spells a bare `status='running'` anymore

## Acceptance

- [ ] A job stays `working` (rolls up its subagent's activity) while a backgrounded subagent is in flight, and the subagent stops rendering a false `[::ok]`
- [ ] One canonical open-turn predicate backs all five liveness sites; reducer guards bounded on `updated_at`, readiness deliberately unbounded
- [ ] Re-fold determinism preserved (the `now = -Infinity` byte-identity contract intact); SILENT_STREAM_CUT untouched; full suite + lint + typecheck green

## Early proof point

Task that proves the approach: `.1`. If it fails: the highest-risk sub-pieces are the
ApiError-guard refactor preserving "stamp the api-error pair always, suppress only the state
flip" and the `updated_at`-tie deterministic anchor pick — fall back to landing the Stop-guard
+ sweep + readiness widening first and isolating the ApiError-guard parity into a follow-up refine.

## References

- fn-480 precedent: `findOpenTurnForStop` (src/subagent-invocations.ts:143-158) already gates on `duration_ms IS NULL` ALONE — the exact shape the new shared helper mirrors
- Kubernetes startupProbe-vs-livenessProbe asymmetry: readiness no-bound (avoid false-positive re-dispatch of a slow worker) = startup probe; reducer 120s sweep = liveness probe

## Docs gaps

- **src/reducer.ts**: `MAX_STOP_YIELD_GAP_SEC` JSDoc (anchor `ts`→`updated_at`, predicate text), `sweepRunningSubagentsToUnknown` JSDoc first line, Stop fold inline comments (~7710-7750), ApiError guard inline comment (~7875) — all still say `status='running'` / spawn-`ts`
- **src/readiness.ts**: `subRunningByJobId` index comment (~546, "ok rows pass silently" is now false); `SUBAGENT_STALENESS_SEC` / `RunningReason` narrative (~283-319) — the "mirrors `MAX_STOP_YIELD_GAP_SEC`" claim is severed (readiness no longer bounded), so the `sub-agent-stale` variant is now a pure visibility affordance; rephrase/delete the "mirrors" sentence
- **README.md**: `subagent_invocations` collection desc (~201) + inline schema comment (~3756) — the `ok` + NULL-`duration_ms` open-turn state is now valid; prune in place, one sentence

## Best practices

- **Whitelist `IN ('running','ok')` is fail-closed / forward-compatible:** an unknown future status never silently passes a liveness guard (a blacklist would)
- **Keep the open-turn definition in ONE canonical place:** drift between consumers is exactly the bug class being fixed — add a parity test asserting every site agrees
- **Liveness threshold belongs at the consume/serve path** (`event.ts - updated_at`), never baked into the fold; never read wall-clock / env inside a fold (re-fold determinism)
- **Asymmetric thresholds are a known-good pattern** (K8s startup vs liveness probe): readiness unbounded avoids a false-positive re-dispatch; the reducer 120s sweep is the liveness probe
