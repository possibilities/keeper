## Description

**Size:** S
**Files:** cli/board.ts, README.md, CLAUDE.md

### Approach

Now that `keeper jobs` owns the jobs list + dead-letter display,
strip them from `cli/board.ts`: delete the ported `renderJobsBody` /
`projectJobRow`, make `renderBody` return the epics body only
(`renderEpicsBody(...).split("\n")`), and remove the dead-letter
surface entirely — `waitingDeadLetterCount`, `persistentBannerPill`,
the `r` `handleReplayKey` / `replayInFlight`, and the `setStatus`
banner re-stamp in `emitFrame`. KEEP the per-epic embedded
`job_links` lines and the work-verb jobs nested under task/close rows
(those are epic rendering, not the bottom list) and KEEP the `c` copy
key — its flash-restore now targets `""` (no persistent pill) instead
of `persistentBannerPill()`. Drop `jobs` from the board state-JSON
sidecar (epics-only). Then update docs: README.md (inline subcommand
list ~165; the "clients ship under the unified keeper CLI" run-on
~395-408 + drop the "combined epics + jobs" parenthetical; split the
Example-clients board bullet ~427-537 into a board entry + a jobs
entry with dead-letter/`r` under jobs; add a `keeper jobs` example
~536), the CLAUDE.md/AGENTS.md design-stance client list (add
`keeper jobs`, one line), and `cli/board.ts`'s module JSDoc + HELP +
`cli/keeper.ts`'s USAGE blurb ("Combined epics + jobs board" →
"Epics board") to describe the epics-only surface. Edit CLAUDE.md in
place (it is a symlink target for AGENTS.md — never rm+recreate).

### Investigation targets

**Required** (read before coding):
- cli/board.ts:1360-1375 — renderBody (return epics-only)
- cli/board.ts:1464-1517 — emitFrame (remove the banner re-stamp + dead-letter count)
- cli/board.ts:1024-1034,1481-1482,1542-1646 — the dead-letter banner + r handler + flash timer to remove (keep c, restore to "")
- cli/board.ts:1-90,119-258 — module JSDoc + HELP to rewrite (epics-only)
- cli/keeper.ts:35-52 — USAGE board blurb
- README.md:165,395-408,427-537 — subcommand lists + Example-clients board bullet
- CLAUDE.md design-stance client list (the `keeper board`, `keeper autopilot`, … line)

**Optional** (reference as needed):
- cli/board.ts:1565-1588 — handleCopyKey (keep; this is the surviving key)

### Risks

The `c` flash-restore previously called `persistentBannerPill()`; with
the dead-letter pill gone, restore must target `""` or board will try
to restore a banner it no longer maintains. Don't accidentally remove
the embedded job_links / nested task-job rendering — those stay.

### Test notes

`bun test test/board.test.ts` stays green (the kept colorizer /
dep-pill / job-link / renderDeadLetterPill pure-function assertions
are unaffected — `renderDeadLetterPill` is still re-exported from
board even though board no longer renders the banner). Run
`keeper board` to confirm epics-only, no jobs section, no banner.

## Acceptance

- [ ] `cli/board.ts` renders epics only — no jobs body, no `~~~` jobs section, no dead-letter banner, no `r` key
- [ ] Embedded `job_links` lines + work-verb jobs nested under task/close rows still render; `c` copy still works (restores to "")
- [ ] board state-JSON sidecar is epics-only
- [ ] README + CLAUDE.md + board/keeper docstrings + HELP + USAGE describe the split and the dead-letter relocation
- [ ] `bun test test/board.test.ts` passes; `keeper board` shows the epics-only frame

## Done summary

## Evidence
