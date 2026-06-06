## Description

**Size:** S
**Files:** test/commit-work.test.ts, test/commit-work-foundation.test.ts, test/find-task-commit.test.ts, test/readiness.test.ts, test/readiness-client.test.ts, test/readiness-diagnostics.test.ts (audit; merge only if safe), README.md / CLAUDE.md (final doc sweep)

### Approach

Audit the two charter-flagged redundancy clusters with `git log`/coverage before any cut: (a) commit-work vs commit-work-foundation vs find-task-commit (all exercise the commit-trailer/discharge path with real git — possibly mergeable into one fixture-sharing file); (b) readiness vs readiness-client vs readiness-diagnostics (possibly testing the same verdicts at three layers). Merge fixture-sharing duplicates ONLY when no distinct assertion is lost — these are low-confidence cut candidates; conservative default is to KEEP if in doubt. Then re-measure: `bun run test:fast` and `bun run test:slow` 5× each, record wall times, and confirm acceptance (fast <10s + 0 flakes, slow 0 flakes). Final doc sweep for any remaining stale test-command references.

### Investigation targets

**Required** (read before coding):
- test/commit-work.test.ts, test/commit-work-foundation.test.ts, test/find-task-commit.test.ts — what each uniquely asserts vs overlaps
- test/readiness.test.ts, test/readiness-client.test.ts, test/readiness-diagnostics.test.ts — the three-layer verdict question
- `git log --oneline` on each file to see why the split exists

### Risks

- **Deleting real coverage:** the charter marks these LOW confidence. A merge that drops a distinct assertion is a regression. Prefer keep-over-cut when uncertain.

### Test notes

Full `bun run test` (fast && slow && opentui) green. Record final wall times vs the ~98-141s baseline. Confirm Python still 41/0.05s untouched.

## Acceptance

- [ ] Both redundancy clusters audited with git-log/coverage evidence; merges (if any) lose zero distinct assertions
- [ ] Final re-measure recorded: fast <10s + 0 flakes over 5 runs, slow 0 flakes over 5 runs
- [ ] Full `bun run test` green; Python untouched (41 tests / 0.05s, no pytest)
- [ ] No stale test-command references left in docs

## Done summary

## Evidence
