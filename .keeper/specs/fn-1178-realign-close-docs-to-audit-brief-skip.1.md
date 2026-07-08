## Description

Fixes finding F1 (kept) with F2 merged in — both trace to source task .1
changing `selection-audit-brief` to return `{success:true, skipped:true}` on
an existing brief and stop emitting `REVIEW_EXISTS`. Verified on the epic
branch: `git show <epic-tip>:plugins/plan/src/verbs/selection_audit_brief.ts`
has zero `REVIEW_EXISTS` and returns the skipped envelope at the write-once
guard.

Files to edit:
- `plugins/plan/skills/close/SKILL.md` (F1) — Phase 3.6a branch table (~line 234): replace the unreachable `REVIEW_EXISTS` branch with a `skipped:true` (success) branch that logs `already captured (re-close)`, so the re-close idempotence path is no longer mislabeled `no auditable cells` by the empty-`auditable_task_ids` branch.
- `docs/problem-codes.md` (F2) — the `REVIEW_EXISTS` row (~line 172): scope "emitted by" to `selection-review-submit` only and note the audit-brief's idempotent-skip in the section prose.

## Acceptance

- [ ] The close SKILL documents a `skipped:true` branch (logs `already captured (re-close)`) and no longer lists a `REVIEW_EXISTS` outcome for `selection-audit-brief`.
- [ ] `docs/problem-codes.md`'s `REVIEW_EXISTS` row lists only `selection-review-submit` as an emitter; the audit-brief's skip behavior is described in prose.
- [ ] No source (`.ts`) behavior change — docs only.

## Done summary

Realigned the close SKILL docs and problem-codes to the audit-brief skip contract; landed on
main as 58770eed. Board state reconciled by the operator: the done stamp's git commit was
lost to the same concurrent-merge window while the daemon projection recorded done; this
commit restores the durable backing.

## Evidence

- main commit 58770eed (docs(plan): realign close SKILL + problem-codes to audit-brief skip contract)
