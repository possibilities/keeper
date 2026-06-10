## Overview

Re-aim the performance babysitter at the post-roadmap signal landscape (fn-759/762/
764/765 collapsed rescue rates to ~0 and deleted the approval mechanism its headline
checks watch): retire dead approval-era checks, re-tune thresholds sized for the
noisy era, add the watches the incident proved missing (duplicate LIVE workers was
caught by a hand-rolled tripwire, not the sitter), pin the sitter's import surface
so keeper refactors can't silently kill its ticks (fn-756 transiently did — only the
watchdog noticed, ~15 min later), and finish with a clean-slate archive of the
330-file untriaged followup backlog (~80% fixed-era noise; level-triggered checks
re-detect anything still real, so clearing loses noise, not signal). Audit basis:
the 2026-06-09 babysitter inventory (all file:line refs verified at commit f96afbc).

## Quick commands

- `bun test --parallel --timeout=30000` — keeper suite green incl. the new sitter build-pin test
- One manual tick: run the watch.ts scan against the live DB and confirm zero approval-era findings, no false autopilot-stall page in armed-mode-nothing-armed
- After task 3: `ls ~/.local/state/babysitters/performance/followups/` ≈ empty; `followups-archive/<date>/` holds the corpus; first post-reset tick pages nothing on a healthy system

## Acceptance

- [ ] dup-approve + approval-review checks deleted; agent prompt + charter carry zero approval-era prose; finding categories list matches what the checks emit
- [ ] thresholds re-tuned for the ~0-rescue era (MISSED_WAKE_DELTA 5→1; ingest-poison per-name page-on-first-delta; fold-latency threshold lowered per its own tunable-DOWN note; autopilot-stall is mode/armed-aware; dup-dispatch semantics annotated against the 200s cooldown + abort split)
- [ ] new watches live: duplicate-live-workers per plan_ref (critical — the re-fire tripwire), dead_letters poison delta, events-log per-pid backlog, DB+WAL growth, keeperd CPU — all from existing inputs + one tiny ps probe; sitter stays pure read-only (no DB writes, no RPC, no synthetic events)
- [ ] a keeper-side test build-pins the sitter entry (a keeper refactor that breaks watch.ts imports fails keeper's own suite at commit time)
- [ ] backlog archived (not deleted), seen.json reset, BACKSTOP_BASELINE_VERSION 2→3 reseed, one processed.jsonl ledger entry recording the bulk archive + rationale

## Early proof point

Task that proves the approach: task 2 (new watches). If the duplicate-live-workers
check can't be expressed from jobs + the injected isPidAlive without new inputs,
stop and re-derive — it is the one check the incident proved load-bearing.

## References

- The 2026-06-09 babysitter audit (in-session; key cites repeated in task specs) + ~/docs/keeper-reliability/2026-06-09-roadmap-state.md
- CLAUDE.md "The babysitters are pure read-only external scanners" — the invariant every new watch must honor
- babysitters/FINDINGS-LEDGER.md (fn-755) — the ledger contract task 3 writes the archive entry into
- Decision record: clear-after-glowup (archive + seen reset + baseline version bump) instead of bulk-triaging 330 stale findings — safe because checks are level-triggered against live state; restart-frequency + zellij-leak watches deliberately deferred (need new inputs; revisit on symptom)
