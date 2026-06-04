## Description

**Size:** S
**Files:** CLAUDE.md, README.md, src/types.ts (JSDoc), src/plan-classifier.ts (header), cli/board.ts (verify only), test/board.test.ts

### Approach

Reconcile the prose with the new authoritative source. CLAUDE.md: revise the
v45/fn-664.2 commit-discharge trailer list to include `Planctl-Op`/`Target`/
`Session-Id`, note `foldCommit` now also triggers the edge rebuild, and qualify
the v46/fn-666 bullet (the envelope still drives `file_attributions`, but
creator/refiner edges now derive from the commit channel — pruning, not append).
README Architecture: update the `planctl_*` column description (~46-78), the
`syncPlanctlLinks` blocks (~1063, ~1488-1492) to say "union of scrape +
commit-trailer", the `foldCommit` changelog paragraph (~1135-1175), and the
cheatsheet SQL comments (~1761-1773). types.ts JSDoc: the `Link` /
`JobLinkEntry` / `Event.planctl_*` source-of-truth sentences. plan-classifier.ts
header: update the "syncPlanctlLinks calls these every triggering event" claim to
"from the union of `planctl_op` events and commit-trailer facts". Board: VERIFY
`renderJobLinkLines` (cli/board.ts:499) renders multiple creator + refiner lines
unchanged (no field change) and add/confirm a test asserting many edges per
session render.

### Investigation targets

**Required:**
- CLAUDE.md event-sourcing + Commit-discharge bullets (v45/fn-664.2, v49/fn-670, v46/fn-666)
- README.md Architecture ~46-78, ~1063, ~1135-1175, ~1488-1492, ~1761-1773
- src/types.ts:11-25 `Link`, :110-153 `JobLinkEntry`, :258-298 `Event.planctl_*`, plus `Job.epic_links`/`Epic.job_links`
- src/plan-classifier.ts:1-53 module header
- cli/board.ts:499 `renderJobLinkLines` (verify only)

### Risks

- Docs-only plus a render-verify test; low risk. Keep edits pruning-not-appending per docs-gap-scout so the trailer-parse boilerplate isn't duplicated across bullets.

### Test notes

test/board.test.ts: assert `renderJobLinkLines` renders N creator + M refiner lines for one epic (many-edges-per-session). No new board code expected.

## Acceptance

- [ ] CLAUDE.md + README + types.ts JSDoc + plan-classifier header reflect the commit-trailer source of truth
- [ ] the board renders multiple creator/refiner lines (verified by test); no `renderJobLinkLines` code change

## Done summary
Reconciled CLAUDE.md, README Architecture, types.ts + plan-classifier.ts JSDoc to the commit-trailer creator/refiner source of truth (scrape ∪ commit-trailer union; foldCommit triggers the rebuild, syncPlanctlLinks stays sole writer); added a board test asserting many creator/refiner edges each render their own line with no renderJobLinkLines code change.
## Evidence
