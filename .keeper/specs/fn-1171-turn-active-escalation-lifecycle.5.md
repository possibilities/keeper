## Description

**Size:** M
**Files:** cli/board.ts, cli/status.ts, src/needs-human.ts, test/board.test.ts, test/status.test.ts

### Approach

Make surface-and-stop blocks visible without changing their no-agent/no-page contract. Board: promote homed `work::` dispatch-failure rows whose reason carries the `blocked:` prefix into the top-of-board needs-human array (net-new feed from the workFailures map in renderBody — today homed rows are deliberately excluded and render only as a task pill). Locator is the task id; the existing needsHumanCount → banner flow picks the rows up automatically (do not add a separate counter). The task pill stays — pill for in-epic locality, top line for attention, double-display intended. Other homed work failures (e.g. worktree reasons) stay pill-only: the promotion predicate is the `blocked:` prefix, nothing broader. Verify `classifyDispatchFailure("blocked: …")` yields the readable `blocked` kind, not unknown.

Status: `blocked:` rows already flow into `stuck_dispatches` → `total` → `jammed`, so the envelope gains a NAMED SUBSET member (count of `blocked:`-prefix work rows) following the `finalize_non_ff` never-double-count pattern — named in the envelope, never re-added to `total`. `isJamReason` and the `keeper watch` delta types are untouched — this class surfaces via board + envelope only.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/board.ts:399-413 — needsHumanLines; :425+ orphanedFailureRows (the exclusion being selectively lifted); :760-810 workFailures/distress feeds + banner; :1061-1070 the needsHuman assembly
- src/needs-human.ts:155-206 — projectNeedsHuman stuckDispatches/total math (the subset must not double-count)
- cli/status.ts:181-205 — the needs_human envelope members + the subset-member comments; :334-395 total/jammed assembly

**Optional** (reference as needed):
- src/dispatch-failure-pill.ts:36 — classifyDispatchFailure prefix rules
- test/board.test.ts:1854-1889 — needsHumanLines suite; test/status.test.ts:304,385-397 — envelope suites incl. the existing work::-blocked worktree-reason case
- src/await-conditions.ts:1044 — isJamReason, untouched by design

### Risks

- The subset-vs-family distinction is the one place to get the math wrong: the new member mirrors finalize_non_ff (named, in total already via stuck_dispatches), never dead_letters (independent adder).

### Test notes

Board: homed blocked row renders one top-block line + keeps its pill; worktree-reason homed row stays pill-only; banner count includes the promoted row. Status: envelope member counts blocked rows; total unchanged versus today for the same fixture.

## Acceptance

- [ ] A homed work:: row with a blocked:-prefix reason renders in the top-of-board needs human block (task-id locator, category visible) and is counted by the [needs-human:N] banner; non-blocked homed rows are unaffected
- [ ] keeper status needs_human gains a named member counting blocked:-prefix rows; total and jammed are unchanged for identical fixtures (no double-count)
- [ ] isJamReason and watch delta types are unchanged

## Done summary

## Evidence
