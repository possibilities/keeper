## Description

Finding F2 from fn-739-dead-letter-backlog-drain audit: scripts/archive-recovered-dead-letters.ts:114-142 implements the eligibility gate (allConfirmed, ids.length === 0, replayed_event_id exclusion, --apply move) with no direct test coverage. The four untested cases per the auditor: (1) file with one still-waiting record left in place, (2) recovered-but-no-replayed_event_id excluded, (3) all-torn ids.length===0 file left untouched, (4) --apply moves eligible file to archive/. Target files: scripts/archive-recovered-dead-letters.ts, test/daemon.test.ts.

## Acceptance

- [ ] Test: file with one still-waiting record is left in place (allConfirmed gate fires)
- [ ] Test: recovered record with no replayed_event_id is excluded, file stays
- [ ] Test: all-torn file (ids.length === 0) is left untouched
- [ ] Test: --apply moves eligible file to archive/ subdir

## Done summary
Added four subprocess-driven tests in test/daemon.test.ts pinning archive-recovered-dead-letters.ts eligibility branches: still-waiting record leaves file in place (allConfirmed gate), recovered-but-no-replayed_event_id excluded, all-torn file (ids.length===0) untouched, and --apply moves a fully-confirmed file to archive/.
## Evidence
