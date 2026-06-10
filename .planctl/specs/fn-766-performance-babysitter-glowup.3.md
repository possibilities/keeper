## Description

**Size:** S
**Files:** babysitters/performance/watch.ts (BACKSTOP_BASELINE_VERSION), ~/.local/state/babysitters/performance/ (runbook ops), ~/docs/babysitters/performance/processed.jsonl

### Approach

The clean-slate cut AFTER tasks 1-2 land: (1) bump BACKSTOP_BASELINE_VERSION 2→3
(watch.ts:740) — the version-tag mechanism silently reseeds every deployed
baseline on the next tick (fires/watermarks re-anchor to the post-glowup world);
commit this. (2) Runbook ops (perform once, document in Evidence): move the
~330-file followups/ corpus to followups-archive/<ISO-date>/ alongside it
(archive, never delete — mirrors keeper's dead-letters archive convention);
reset seen.json (remove it — the sitter rebuilds it empty on next tick; this
clears retired-class fingerprints and the one entry stuck at the 5-spawn-failure
cap); leave heartbeat.json + watchdog untouched. (3) Append ONE entry to
~/docs/babysitters/performance/processed.jsonl recording the bulk archive:
verdict bulk-archived, count, date, rationale ("fn-759/762/764/765 closed the
classes generating ~80% of the corpus; level-triggered checks re-detect anything
still live") — so the fn-755 ledger history starts truthful. (4) Watch one full
tick afterward and record in Evidence that a healthy system pages nothing and
the baseline file shows version 3.

### Investigation targets

**Required** (read before coding):
- babysitters/performance/watch.ts:740, :760-830 — version + load/reseed semantics
- babysitters/FINDINGS-LEDGER.md — the processed.jsonl row shape for the archive entry
- ~/.local/state/babysitters/performance/ — live layout (followups/, seen.json, heartbeat.json, backstop-baseline.json)

### Risks

- Do NOT touch heartbeat.json (the watchdog reads it) or delete anything — archive only.
- Time the seen.json reset right after the archive mv so a mid-window tick can't
  re-page archived findings against an empty seen-state... it can re-page LIVE
  findings — that is the desired re-detect property; only the file mv + reset
  ordering matters (mv first, then reset).

## Acceptance

- [ ] baseline version 3 committed; post-tick baseline file reseeded
- [ ] corpus archived to followups-archive/<date>/; seen.json reset; ledger entry appended
- [ ] one observed post-reset tick: no pages on a healthy system (Evidence)

## Done summary

## Evidence
