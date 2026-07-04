## Description

Finding F1 (auditor Standards item `PROVENANCE_COMMENT`). CLAUDE.md rule #0
bans fn-ids, version numbers, dates, and past-tense provenance in comments
and docs. The fn-1107 diff introduced change-history narration in code
comments. Verified against the fn-1107 commit set (git blame):

- `src/autoclose-worker.ts:22` — "the prior tmux-heuristic reaper — fn-1005
  — is dead scar tissue" (introduced by 1cddc38d).
- `src/autoclose-worker.ts:33` — "exactly how the prior incarnation
  interrupted live sessions — commit 5b844449" (introduced by 1cddc38d).
- `src/autoclose-worker.ts:2` and `src/daemon.ts:3087,7468` — `(epic
  fn-1107)` header tags (introduced by 1cddc38d / 60375923).
- Per the auditor, also sweep the src/reducer.ts stamp comment and src/db.ts
  + new doc-comment headers for the same `(epic fn-1107)` / fn-id / SHA
  provenance.

Remove the past-tense/SHA/fn-id provenance while KEEPING the current-behavior
"why fail-closed" rationale intact (it is genuinely load-bearing). Do NOT
touch src/reconcile-core.ts:501,724 (`RESERVED for task .2`) — pre-existing,
out of scope. Do NOT touch migration version tags or `fn-NNN:` test names.

## Acceptance

- [ ] The fn-1005 "scar tissue", `commit 5b844449`, and "prior incarnation"
      narration is removed from src/autoclose-worker.ts.
- [ ] `(epic fn-1107)` / fn-id provenance tags are removed from the
      fn-1107-introduced comments (autoclose-worker.ts, daemon.ts,
      reducer.ts stamp comment, db.ts, new doc-comment headers).
- [ ] The "why fail-closed" negative-gate rationale prose is preserved.
- [ ] `bun scripts/lint-claude-md.ts` stays green; no source behavior changes.

## Done summary
Pruned fn-1107 change-history provenance narration from code comments (comment-only, zero behavior change). Fast-forwarded the lane to latest main (40cb723d), which brought in fn-1107 autoclose-worker.ts (landed at 0c15abd7). Removed: autoclose-worker.ts header (epic fn-1107) tag + the fn-1005 dead-scar-tissue parenthetical + the prior-incarnation/commit-5b844449 narration (fail-closed rationale rewritten present-tense: a retry against a since-recycled pane id can interrupt a live session); daemon.ts three (epic fn-1107) tags; reducer.ts dispatch-provenance stamp (fn-1107) tag; types.ts dispatch_origin doc-header fn-id (kept (schema v107) to match the sibling (schema v100 / fn-1024) convention). LEFT db.ts:5939 v107-to-v108 (fn-1107.1) migration version tag untouched -- explicitly out of scope (protected migration-tag convention). why-fail-closed rationale preserved throughout.
## Evidence
- Commits: d976ce3e
- Tests: fast gate 5836+76 pass / 0 fail, whole-project tsc --noEmit clean, biome check clean on the 4 changed files, bun scripts/lint-claude-md.ts green