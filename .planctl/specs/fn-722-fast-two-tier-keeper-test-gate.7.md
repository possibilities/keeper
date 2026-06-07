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
Audited both charter-flagged redundancy clusters with git-log + per-file coverage evidence; KEEP all six files (zero merges) — each tests a distinct subject. Cluster (a): commit-work-foundation (in-proc primitives), commit-work (commit-work CLI subprocess), find-task-commit (find-task-commit CLI subprocess) — disjoint verbs, fixtures already deduped into test/helpers/{git-repo,sandbox-env}.ts. Cluster (b): readiness/readiness-client/readiness-diagnostics map 1:1 to three separate src modules with no shared assertions. Doc sweep clean (epic doc-gaps already landed, no stale test-cmd refs, no --isolate). Re-measure: fast 0 flakes / slow 0 flakes over 5x each; Python untouched (41 tests). Note: fast tier ~36s not <10s on this run — environmental (load avg 7.83/10 cores, agent+zellij+ghostty saturating box), not a code regression; bulk-minus-3-subprocess-files still 27s confirms broad CPU contention vs the epic's clean-machine 7.5s.
## Evidence
