## Description

**Size:** M
**Files:** src/reducer.ts, test/reducer.test.ts

### Approach

- Add constant `KILLED = "killed"` alongside `ENDED` (`src/reducer.ts:69-70`).
- Add `case "Killed":` branch in `projectJobsRow` switch (`src/reducer.ts:453-540`). Reads `(pid, start_time)` from the event payload; matches against the jobs row's stored values; on mismatch (or missing pid), treat as a stale event and short-circuit safely — cursor still advances, no row write, no throw (gap-analyst Q3 + Q7 outcomes). When the jobs row has no stored `start_time` (legacy), accept any incoming Killed for that pid (Q7 loose-match for legacy).
- Extend `case "SessionStart":` re-open from `WHEN jobs.state = 'ended'` to `WHEN jobs.state IN ('ended','killed')` (around lines 478-486); refresh both `pid` and `start_time` via `COALESCE(excluded.X, jobs.X)`.
- Add `killed` to UserPromptSubmit's terminal-revival scope so a fresh prompt also re-opens killed rows to `working` (mirrors SessionStart's re-open semantics).
- Per Q3: add `WHERE state NOT IN ('ended','killed')` terminal guard to Stop (currently `!= 'ended'` at ~line 521) and to any other non-SessionStart / non-UserPromptSubmit hook event that today un-flips terminal states.

### Investigation targets

**Required** (read before coding):
- `src/reducer.ts:69-94` — terminal constants + title-precedence pattern
- `src/reducer.ts:281-286` — `projectPlanRow` orphan skip pattern (precedent for safe no-op on malformed payload)
- `src/reducer.ts:453-540` — `projectJobsRow` switch
- `src/reducer.ts:478-486` — SessionStart re-open + COALESCE pid pattern
- `src/reducer.ts:515-522` — Stop terminal guard precedent
- `test/reducer.test.ts:259-275` — rewind-and-re-fold determinism pattern

**Optional**:
- `src/reducer.ts:18-38` — header state-machine prose (do NOT rewrite here; the docs sweep in task 8 owns this)

### Risks

A throw inside the fold transaction wedges the reducer (CLAUDE.md invariant). The Killed fold MUST short-circuit safely on any malformed payload. Re-fold determinism MUST be preserved — the fold reads the event's `start_time` at face value; never re-probe liveness inside the fold (that lives in the producer).

### Test notes

Re-fold-from-cursor=0 reproduces identical jobs rows. Test cases: (a) Killed event with matching `(pid, start_time)` → killed; (b) Killed with mismatched start_time → no-op, cursor advances; (c) Killed against legacy row with null stored start_time → killed (loose match); (d) SessionStart on killed → stopped + refreshed pid/start_time; (e) UserPromptSubmit on killed → working + refreshed; (f) Stop on killed → no-op (terminal guard); (g) PostToolUse on killed → no-op; (h) re-fold determinism.

## Acceptance

- [ ] `case "Killed":` branch lands; folds to killed only when `(pid, start_time)` match OR the row's stored start_time is null (legacy); safe no-op on mismatch; never throws
- [ ] SessionStart + UserPromptSubmit re-open killed rows to stopped/working respectively, refreshing pid+start_time via COALESCE
- [ ] Stop, PostToolUse, Notification (and any other non-SessionStart / non-UserPromptSubmit hook event) ignore killed rows
- [ ] Re-fold from cursor=0 reproduces every test row byte-identically

## Done summary

## Evidence
