## Overview

A session that ends a turn to wait on background tasks gets its jobs row flipped to `stopped` by the plain Stop fold; if it resumes via a task-notification whose status falls outside completed/failed (or the suppressed killed variant), no UserPromptSubmit revival fires — and the tool events that then stream in have NO un-stop path, because both existing tool-event un-stops are annotation-column-gated. The session reads stopped indefinitely while demonstrably working (live repro today). Fix: a third, bare tool-event un-stop arm — safe because the resurrection guard is the inner state='stopped' CASE, not the annotation gate — plus an evidence-backed classification of which notification variants revive.

## Quick commands

- `bun test test/reducer-lifecycle.test.ts test/jobs.test.ts` — the Stop/revival lifecycle coverage
- `keeper query jobs --filter state=working` while a background-driven session runs tools — the row must read working

## Acceptance

- [ ] A plain-stopped row folds back to working on the next PreToolUse/PostToolUse; ended/killed rows are never resurrected
- [ ] active_since stamps only on the stopped-to-working rising edge; embedded epic/task job mirrors stay in sync; hot-path cost unchanged for working rows
- [ ] The live repro's entry path is classified from the event log and recorded; the killed-suppression decision is re-affirmed or amended on that evidence
- [ ] Re-fold determinism holds over the new arm

## Early proof point

Task that proves the approach: `.1` — the red-first lifecycle test (Stop-stopped row + tool event → working) fails on current source. If it fails post-change: the arm's WHERE gate is the first suspect (must match on state='stopped' only).

## References

- The two annotation-gated un-stops and the CASE guard: src/reducer.ts:8388-8459 (arms), :8398-8405 (why the narrow gate can never resurrect terminal rows)
- fn-1008's Stop guard consults in-flight subs only WITHIN the 120s freshness window (src/reducer.ts:8093-8102, src/subagent-invocations.ts:245-276) — this epic covers the resume AFTER
- Task-notification classifier: src/derivers.ts:345-363 + the killed-suppression at src/reducer.ts:7915-7936 (completed/failed revive via UPS; killed breaks)

## Docs gaps

- **README.md**: the revival contract is stated in THREE places (intro ~45-50, epic-link section ~3040-3042, the Inspect jobs comment ~4069) — consolidate to the intro as canonical and cross-reference, updating all to the new tri-trigger reality; anchor by content, not line (fn-1055 sweeps README after this lands)

## Best practices

- **Turn-idle is not session-stopped** — the fold-level fix treats any current-session tool event as proof of liveness; epoch safety is carried by job_id keying and the terminal-state CASE
- **No wall-clock in the fold** — the freshness bound and all new logic stay event-carried
- **Idempotent, cold-when-no-op writes** — gate the new UPDATE on state='stopped' in the WHERE so the 50+/turn tool path never touches working rows
