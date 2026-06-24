## Overview

The autopilot reconciler merges a "recently-done epics" read into its
snapshot so a completed epic stays visible long enough for the close-row
completion reap to observe its `{tag:"completed"}` verdict. Today that read
is bounded by COUNT (`LIMIT 32` on `updated_at desc`), but the requirement
it serves is a DURATION — keep the epic visible through its done→idle
wind-down. A count bound couples reap-visibility safety to completion
burst-rate (its own docstring admits "only UNDER-observing leaks"). This
epic converts the bound to a time window using the existing `recencyBound`
descriptor idiom (proven on `subagent_invocations`): a new
`epics_recent_done` collection scoped to `status='done'` with an
`updated_at >= now - 1800s` floor. End state: the done-epics read is bounded
by a principled duration, the count footgun is gone, and the mechanism
reuses battle-tested serve-path code.

## Quick commands

- `bun run test:full` — full suite; the gate (the fast tier skips the integration files)
- `bun test test/autopilot-worker.test.ts test/collections.test.ts test/server-worker.test.ts` — the three directly-touched suites
- `grep -rn "DONE_EPICS_REAP" src/ test/` — confirm the rename landed and no `_LIMIT` survives

## Acceptance

- [ ] The recently-done-epics read is time-bounded (`updated_at >= now - DONE_EPICS_REAP_WINDOW_SEC`), not count-bounded; no `LIMIT` on that read.
- [ ] The new descriptor mirrors `EPICS_DESCRIPTOR`'s full column/jsonColumn surface so merged done rows stay full `Epic` objects.
- [ ] Re-fold determinism untouched (read-time producer path only; no fold reads wall-clock).
- [ ] `bun run test:full` green.

## Early proof point

Task that proves the approach: `.1` (the whole change is one task). If it
fails, the likely culprit is row-shape divergence (descriptor trimmed
columns) or the seconds-vs-ms unit trap in the migrated tests — both are
named in the task Risks with the exact fix.

## References

- `recencyBound` template: `src/collections.ts:402` (`subagent_invocations`), applied in `resolveFilter` at `src/server-worker.ts:1140-1144`.
- Overlap awareness: **fn-945** edits the same `loadReconcileSnapshot` function (paused-state resume) plus CLAUDE.md/README.md — adjacent edits, sequence to avoid conflict. **fn-949** reads `src/autopilot-worker.ts:1646` (investigation-only) — low risk.
- Backstop for a closer wedged past the window: the exit-watcher dead-pid reprobe (`src/exit-watcher.ts`) mints a synthetic `Killed`, so the window is not the sole safeguard.

## Docs gaps

- **CLAUDE.md (~line 237)**: revise the `recencyBound` example to list `epics_recent_done` on `updated_at` alongside `subagent_invocations` (revise, don't append). Edit in place — `AGENTS.md` is a symlink.
- **README.md (~255-264)**: same example-list refresh in the subscribe-serve-path `recencyBound` paragraph.
- **README.md (~3206)**: restate the `loadReconcileSnapshot` "merged recently-done epics read" sentence as time-windowed via `epics_recent_done`.

## Best practices

- **Window sizing:** must exceed worst-case close-row wind-down with a safety factor; 1800s tracks `MONITOR_RELEASE_SEC` and is ~10-30x a healthy wind-down. [practice-scout / Tigris TTL rule]
- **Boundary testing:** pin the clock and test `now-window-1` / `now-window` / older — interior-only tests miss unit bugs because the window is large. [practice-scout]
- **Backstop, not sole safeguard:** an item whose processing exceeds the window silently drops; the exit-watcher reprobe covers the wedged-closer tail, not the window. [practice-scout / SQS visibility-timeout]
