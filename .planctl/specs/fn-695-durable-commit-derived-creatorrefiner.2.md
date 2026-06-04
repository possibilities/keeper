## Description

**Size:** M
**Files:** src/git-worker.ts, src/derivers.ts, src/daemon.ts, test/git-worker.test.ts

### Approach

Producer side: lift `Planctl-Op` + `Planctl-Target` off each commit and freeze
them onto the `Commit` event payload alongside the existing
`committer_session_id` / `task_ids`. Extend `enumerateCommitsInDelta`'s
`%(trailers:key=...)` format (~git-worker.ts:1032) to add `Planctl-Op` +
`Planctl-Target` with the SAME `valueonly`/`unfold` flags as `Session-Id`, and
widen the stride parser in lockstep (loop ~:1080: groups of 6 → 8; `i+5`→`i+7`,
`i+=6`→`i+=8`) — THE fragile site; keep the `%x00` field discipline uniform.
Mirror `parseSessionIdTrailer` / `parseTaskTrailers` for a defensive Op/Target
parse (validate the target via the same epic-ref shape `parsePlanRef` uses;
NULL on miss; normalize the op via `normalizePlanctlOp`). Widen
`EnumeratedCommit` (~:837) + `CommitMessage` (~:228) + the postMessage mint
(~:1777) + `CommitPayload`/`extractCommit` decode (derivers.ts:1457/:1515),
defaulting both fields to NULL on pre-feature events (mirror the `task_ids → []`
block at derivers.ts:1627). `daemon.ts:2191`'s commit arm carries the new fields
free via the spread.

### Investigation targets

**Required:**
- src/git-worker.ts:1015 `enumerateCommitsInDelta`, :1032 trailer format, :1080 stride loop (THE fragile 6→8 widening)
- src/git-worker.ts:837 `EnumeratedCommit`, :228 `CommitMessage`, :1777 postMessage mint
- src/derivers.ts:1515 `extractCommit`, :1457 `CommitPayload`, :1627 the `task_ids` defensive-null default (pattern to mirror), :1332 `parseSessionIdTrailer` / :1384 `parseTaskTrailers` (parse idioms)
- src/plan-classifier.ts:103 `normalizePlanctlOp` (normalize the lifted op identically to the scrape path)

**Optional:**
- src/daemon.ts:2191 commit arm (confirm new fields ride the spread)

### Risks

- Stride 6→8 off-by-one realigns EVERY field for EVERY commit in a delta — exhaustive unit coverage of multi-commit deltas with and without the new trailers is mandatory.
- Pre-feature `Commit` events MUST decode `planctl_op`/`planctl_target` to NULL so historical re-fold stays a no-op.

### Test notes

test/git-worker.test.ts: trailer-lift cases (Op+Target present / absent / malformed target / multi-commit delta) alongside the Session-Id/Job-Id cases (~:1062); `extractCommit` decode cases (well-formed / legacy-null / bad-shape) mirroring `task_ids` (~:537-772).

## Acceptance

- [ ] `EnumeratedCommit` / `CommitMessage` / `CommitPayload` carry `planctl_op` + `planctl_target`
- [ ] git-worker lifts both trailers with the stride parser correct for N-commit deltas (no field misalignment)
- [ ] `extractCommit` defaults both to NULL on pre-feature `Commit` events
- [ ] new + existing git-worker tests green

## Done summary

## Evidence
