## Description

**Size:** M
**Files:** src/plan-worker.ts, test/plan-worker.test.ts

### Approach

Thread a per-call `triggeredByCommit` discriminant through
`PlanScanner.onChange(path, triggeredByCommit = false)`. When `true`, skip
the `isTracked` gate at `:1038` entirely — the `planctl-commit-changed`
signal already proves the path is in HEAD (the git-worker enumerated it
from a landed commit) — and emit directly. The `planctl-commit-changed`
worker handler (`:1884-1910`) passes `true`; the live `@parcel/watcher`
callback (`:2055`) and `recheckPending` (`:1071`) pass `false` (stay gated
— those are the genuinely-uncertain paths). Do NOT touch the
`reemitTaskFromDef` gate at `:904`: task-state sidecars are gitignored and
never appear in a commit's file list, so the commit-driven loop never
reaches it; it correctly stays gated.

Make the gate bounce loud: when `!isTracked(path)` fires, `this.log` one
line with the path and that it is the gated FSEvents/recheck path (a bounce
on the commit path is now impossible by construction). Add a "backstop did
real work" signal: when the 60s `reconcilePlanctlDirs` heartbeat or an
`isDropError` rescan emits a snapshot for a path NOT already drained by a
fast path this cycle, `this.log` a trigger-reason-tagged line
(`heartbeat` / `fswatcher-drop`) so a heartbeat firing in normal operation
is visible. Keep all logging through the existing `this.log` sink (stderr,
`[plan-worker]` prefix); never a synthetic event (re-fold determinism).

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:922-1053 — onChange; `:1038` gate is the bypass site
- src/plan-worker.ts:1884-1910 — planctl-commit-changed handler; passes triggeredByCommit=true
- src/plan-worker.ts:1066-1073 — recheckPending; its internal onChange passes false
- src/plan-worker.ts:900-916 — reemitTaskFromDef; the `:904` gate STAYS gated (do not touch)
- src/plan-worker.ts:1355-1377 — isPathInHead (the fail-closed probe being bypassed)
- src/plan-worker.ts:1951-1960 and 2024-2058 — heartbeat reconcile + isDropError rescan (the "did real work" log sites)

**Optional:**
- test/plan-worker.test.ts:1687-1867 — git()/gitInit() helpers + the canonical pending->commit->recheckPending->drain test

### Risks

- The change-gate (`lastEmitted`) plus the autopilot dirty-repo gate backstop the rare case where the worktree diverged from committed bytes after the commit-changed signal — acknowledge, do NOT re-add a probe.
- "Backstop did real work" detection must not double-log normal first-time emits — gate it on "path not already drained by a fast path this cycle."

### Test notes

- New test: commit-driven path emits WITHOUT calling isPathInHead — inject an `isPathInHead` that throws/returns false, assert `triggeredByCommit=true` still emits.
- New test: a live FSEvents/recheck call still bounces an uncommitted file to `pending` (gate preserved) and now logs the bounce (`logs.some(l => l.includes(path))`).
- Route any spawn test through the sandboxed base-env helper (all four state paths).

## Acceptance

- [ ] `onChange(path, triggeredByCommit=true)` emits without invoking `isPathInHead`
- [ ] planctl-commit-changed handler passes `true`; `recheckPending` + the FSEvents callback pass `false`
- [ ] `reemitTaskFromDef` `:904` gate unchanged
- [ ] fn-629 pending bounce logs path + reason; heartbeat/drop rescan logs a trigger-reason tag when it delivers work a fast path missed
- [ ] tests cover bypass-emits and gate-preserved-on-uncertain-path

## Done summary

## Evidence
