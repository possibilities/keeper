## Description

**Size:** S
**Files:** claude/arthack/hooks/pre_tool_use.ts, claude/arthack/hooks/tests/

### Approach

Two bounded arthack-side changes (observe-now scope — no behavior removal). (1)
Attributability: every sub-hook action that alters execution — a command rewrite
(COMMAND_REDIRECTS at :61-90, updatedInput at :590) or the blanket auto-approve (:50) —
already flows through the merged envelope; ensure each rewrite/approval appends a compact
provenance note to additionalContext (e.g. "arthack:command_redirect rewrote python3 -> uv run
python3") so sessions and forensics can attribute machine edits, and auto-approvals are
distinguishable from human/harness approvals in observed behavior. (2) Guard the uv/pnpm
rewrites' PATH assumption: rewrite only when the target binary is resolvable in the hook's
environment (cheap existsSync/PATH probe, cached per process) — evidence: worker/agent
sessions hit command-not-found uv after the rewrite, with one session thrashing 84 export
PATH attempts. Keep the dispatcher's fail-open contract intact (any internal throw still
emits the bare allow).

### Investigation targets

**Required** (read before coding):
- claude/arthack/hooks/pre_tool_use.ts:50,61-90,590 — approve, redirect table, updatedInput
- claude/arthack/hooks/_lib.ts — envelope merge + emit helpers
- claude/arthack/hooks/tests/ — existing test harness for the dispatcher

### Risks

- additionalContext is injected into live sessions — keep provenance notes one short line so this never becomes its own token tax.

### Test notes

Extend the dispatcher tests: rewrite-with-binary-present rewrites + notes provenance;
binary-absent leaves the command untouched; throw path still emits bare allow.

## Acceptance

- [ ] Rewrites and auto-approvals carry compact provenance in additionalContext
- [ ] uv/pnpm rewrites no-op when the target binary is unresolvable; fail-open preserved
- [ ] Dispatcher tests cover both behaviors

## Done summary

## Evidence
