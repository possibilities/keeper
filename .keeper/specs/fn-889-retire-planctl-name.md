## Overview

Retire the "planctl" name across keeper + arthack → "keeper plan" / ".keeper" / "plan". GRANDFATHER exactly two permanently-frozen things and destroy everything else: (1) the literal `Planctl-Op` / `Planctl-Target` / `Planctl-Prev-Op` commit-trailer strings (they live in immutable git history; the git-log scrape + passthrough regex that read them stay), and (2) the load-bearing schema-history literals in `src/db.ts` (the `CREATE TABLE`/`addColumnIfMissing`/backfill/idx steps that a fresh-DB walk replays in order — renaming them breaks the v66→v78 sequence). Everything else — incidental symbols/vars/comments/docs/test-descriptions, the `.planctl/` exclude-prefix, the `PLANCTL_*` env fallbacks, the vestigial `planctl-bun` build, the synthetic Commit-event `events.data` keys, the badge CHECK, the wire-kind dual-accept, and the arthack residue — gets destroyed.

Much of the old `docs/planctl-strip.md` roadmap already shipped (schema v78 renamed the `planctl_*` columns + rewrote the `planctl_invocation` envelopes; the badge is data-clean; the wire-kind producer already emits `plan-commit-changed`). The one un-migrated re-fold keystone is the synthetic Commit-event `events.data` keys `planctl_op`/`planctl_target` (4,409 live events) — handled by a v81 migration in `.3`.

Depends on fn-884 + fn-885 (they churn `CLAUDE.md`, `src/derivers.ts`, hooks, the plan plugin); land after both, with `git rerere` enabled for the rebase.

## Quick commands

- Done-gate: `rg -n 'planctl' /Users/mike/code/keeper --glob '!.keeper/specs/**'` returns ONLY the ratified frozen allowlist (trailer literals + schema-history literals).
- `bun run test:full` (mandatory — db/reducer/git-worker/daemon paths) + `PLANCTL_RUN_SLOW`→new-name plan slow suite.

## Acceptance

- [ ] repo-wide grep for "planctl" (all case variants) returns ONLY the frozen allowlist in both repos
- [ ] the literal `Planctl-*` trailer strings + their readers, and the `src/db.ts` schema-history literals, are UNCHANGED
- [ ] the v81 Commit-event-key migration rewrites the 4,409 historical events + flips producer/read single-path; `test/refold-equivalence.test.ts` extended and green; SCHEMA_VERSION bumped + added to `SUPPORTED_SCHEMA_VERSIONS`
- [ ] a lint guard bans the retired name (with an allowlist exemption); `bun run test:full` green

## Early proof point

Task that proves the approach: `.1` (AST codemod + frozen allowlist). If the codemod can't cleanly separate frozen literals from renamable symbols, the mechanical-sweep premise is wrong — fall back to per-file manual renames guided by the allowlist.

## References

- `docs/planctl-strip.md` — the (stale) roadmap; this epic both executes and retires it. The gap-analysis corrected it: Problem A (columns/envelope) shipped v78; badge data-clean; wire-kind producer flipped; the live keystone is the Commit-event data keys.
- Frozen literals: `plugins/plan/src/commit.ts:201-203` (trailer emit), `src/git-worker.ts:959-960` (git-log scrape), `cli/commit-work.ts:72` (passthrough regex); schema-history literals `src/db.ts:435,1066-1075,2078-2082,3729` + the v78 rename block `:4047-4199`.
- Keystone: producer `src/git-worker.ts:1961-1962`, read `src/derivers.ts:1282-1305`, persist `src/daemon.ts:2554-2562`; charter test `test/refold-equivalence.test.ts:761`; `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS`.
- Codemod practice: AST (jscodeshift/ast-grep) not regex; all case variants; negative-lookahead identifier boundaries; one atomic mechanical commit + `git rerere`. arthack `ln`-retirement is the proven template (`scripts/lint-skill-prefixes.sh` ban + `install.sh` cleanup).

## Alternatives

- Commit-event keys: FREEZE as a permanent dual-read (like the trailers) instead of the v81 migrate-and-flip in `.3`. Lower risk, but leaves planctl residue in `events.data` forever — rejected in favor of "once and for all" per the human; flip `.3` to a freeze if risk appetite changes.

## Rollout

`.1` lands as one atomic mechanical commit (rerere replays the conflict resolution onto fn-884/fn-885 rebases). The v81 migration (`.3`) is forward-only, version-guarded, idempotent, and re-fold-tested before landing; it is the only schema-bumping task and must NOT ride the mechanical commit. Rollback: revert per-task; the migration is additive-rename (re-fold reproduces under the new keys).
