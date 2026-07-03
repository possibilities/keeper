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

## Evidence
