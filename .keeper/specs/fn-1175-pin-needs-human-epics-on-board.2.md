## Description

**Size:** M
**Files:** cli/board.ts, cli/status.ts, test/board.test.ts, test/status.test.ts

### Approach

Consume the pinned-epic member on the two operator surfaces so a pinned closed epic
renders as a full block and each failure surfaces in exactly one place. Board: opt
into the new flag; pinned epics arrive in the typed epics set (dep task's merge), so
the epic grid renders them through the existing block path — the work here is the
exactly-one-place invariant and the counts: extend the orphan-detection open-id set
with pinned ids so a failure homed to a pinned block leaves the orphan needs-human
line (the banner count follows automatically — it sums distress + orphans), and keep
the summary block's open/running counts derived from plan status, so a pinned done
epic never inflates "open". Status: opt in likewise; the board.epics mirror and its
epic-id set now include pinned epics so their close verdicts and dispatch_failure
kinds populate; pinned epics stay OUT of the needs-human total (their failure rows
already count via stuck_dispatches — no new count field, no status-schema change).
Render trusts the collection; a one-frame pill/block skew between the two
subscriptions is accepted self-healing inconsistency, not a latch to add.

### Investigation targets

*Verify before relying — fn-1172.3 and concurrent TUI work are editing these files;
re-read before editing.*

**Required** (read before coding):
- cli/board.ts:1014-1035 — renderEpicsBody: epicIds set + orderEpicsForScheduling +
  renderEpicBlock map (where pinned epics enter the grid)
- cli/board.ts:1042-1082 — renderBody head-block assembly (needsHuman + summary)
- cli/board.ts:425-460 — orphanedFailureRows({openEpicIds,...}): the set to extend
  so homed failures drop out; board.ts:774,1070 needsHumanCount consumes it
- cli/board.ts:883-897, 899-1012 — closeFailureReasonFor + renderEpicBlock (the
  [failed:<kind>] pill path a pinned epic reuses; closeFailures/workFailures maps
  from the existing dispatch_failures subscription at :1256-1310 — no new
  subscription)
- cli/board.ts:1172-1190 — the board subscribeReadiness opts (add the new flag)
- cli/status.ts:266, 288-318, 334-395, 560-573 — epicIds derivation, board.epics
  mapping, needs-human keep-out-of-total discipline, subscribe opts
- cli/board.ts:370-381 — boardSummaryLines counts (keep plan-status-derived)

**Optional** (reference as needed):
- test/board.test.ts:1854-1998 — orphan/needs-human helper test cluster (extract
  any new merge/dedup logic as a pure helper and test it there)
- test/status.test.ts:85-104, 479-523 — snapshot fixture wiring + count assertions

### Risks

- Banner double-count is the correctness edge: a failure must appear as EITHER a
  pinned block pill OR an orphan line, never both — assert it directly
- Board golden line arrays will shift; update deliberately, not by blind re-record
- Both files are contended (fn-1172.3 in progress, concurrent TUI session) —
  re-verify structure at execution time

### Test notes

Board: fixture with a done epic + live close failure row → full block rendered with
failure pill, zero orphan lines for that epic, needsHumanCount excludes it; same
epic open → renders once. Multi-row epic (two finalize rows) → one block, one orphan
dedup covering all its rows. Status: pinned epic present in board.epics with
dispatch_failure kinds; needs_human total unchanged by pinning.

## Acceptance

- [ ] `keeper board` renders a plan-closed epic with a live close/work failure row
      as a full epic block (real status pill + failure pill) that disappears once
      the row clears; the summary "open" count is unchanged by pinning
- [ ] That failure produces no orphan needs-human line and the needs-human banner
      count does not double-count it
- [ ] `keeper status --json` board.epics includes pinned epics with close verdicts
      and dispatch_failure kinds; the needs-human total is unchanged by pinning
- [ ] Full fast suite green (bun test)

## Done summary
Board and status opt into includePinnedEpics (ADR 0018): a plan-closed epic with a live close/work dispatch failure renders as a full board block and appears in keeper status --json board.epics with its dispatch_failure kinds, in exactly one place, with open/needs-human counts unaffected by the pin.
## Evidence
