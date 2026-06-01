## Overview

`.planctl/{epics,tasks}/*.json` and `.planctl/specs/*.md` are written by the
planctl CLI (scaffold/approve/close/done/sort_path), NOT by a Claude
Write/Edit or recognized bash mutation — so keeper's reducer records ZERO
`file_attributions` for them and they show as strict-mystery orphans the
instant they flash dirty (a 559-orphan spike across 4 repos was caught, all
planctl files). This is the dominant burn-in blocker for the orphaned-files
streak. The honest fix: the planctl_op event's envelope already carries a
repo-relative `files` array naming exactly what the op wrote (verified
across 400 live envelopes); lift it into a new `events.planctl_files`
column and mint `source='planctl'` `file_attributions` for those paths,
attributed to the op's session. The files DO have a known author; the
surface just wasn't recording it. End state: planctl-written tracked files
attribute to their triggering session, discharge on the following
`chore(planctl)` commit via the existing path, and no longer orphan.

## Quick commands

- `sqlite3 "file:$HOME/.local/state/keeper/keeper.db?mode=ro" "SELECT project_dir, orphaned_count FROM git_status WHERE orphaned_count > 0"` — must stay 0 through planctl ops
- `bun test test/reducer.test.ts test/derivers.test.ts` — mint + deriver + re-fold determinism
- verify on a DB copy: re-fold from cursor 0 → .planctl orphans drop to ~0 AND projections byte-identical

## Acceptance

- [ ] planctl-written tracked files (every path in the `planctl_op` envelope's `files` — JSONs AND specs) get a `source='planctl'` file_attribution attributed to the op's session; they stop orphaning
- [ ] Re-fold determinism preserved: paths come from the event (new `events.planctl_files` column), ts from the event; a from-scratch re-fold reproduces byte-identical projections (incl. across the `source`-CHECK table rebuild)
- [ ] Discharge works (planctl attributions clear on the `chore(planctl)` commit via the existing foldCommit path); pass-2 inferred-guard + pass-3 render-whitelist widened to `'planctl'` so files neither double-attribute nor mislabel
- [ ] Schema bump correct: additive `events.planctl_files` + version-guarded `file_attributions.source` CHECK rebuild (rows preserved byte-identical) + keeper-py `SUPPORTED_SCHEMA_VERSIONS` updated in the SAME change
- [ ] Verified on a DB copy that the `.planctl` orphan spikes drop to ~0

## Early proof point

Task `.1` Phase 1 (lift `files` + mint, on a DB copy) proves the orphan drops
to zero before the schema rebuild + backfill land. If the envelope `files`
array turns out incomplete for some op, fall back to deriving the residual
paths from the planctl_epic_id/task_id columns for that op only.

## References

- Root cause + 559-orphan capture: `~/docs/keeper-reliability/findings.md` ("ORPHAN CLASS: .planctl/**/*.json churn", 2026-05-31)
- Envelope `files` (repo-relative, verified 400 envelopes): lifted by `extractPlanctlInvocation` (`src/derivers.ts:392`) into a new column
- Mint reuses pass-1 upsert (`src/reducer.ts:1758`); discharge reuses `foldCommit` (`src/reducer.ts:2248`); trigger seam is the `planctl_op != null` fold (`src/reducer.ts:5621`)
- `.planctl/state/` (incl. touched/*.txt) is GITIGNORED — only tracked JSONs + specs orphan; do NOT mint from `touched_path_files`
- `fn-664-gate-commit-discharge-on-worktree-oid` (overlap, hard dep): rewrites the same discharge predicate + bumps schema — land it first, rebase on top

## Best practices

- **Attribute to the triggering session, not a phantom planctl actor** (jobs rows come only from SessionStart).
- **Mint at the planctl_op fold so the file_attribution is present before the next GitSnapshot** — pass-1/pass-3 then just read it; don't re-scan per dirty file.
- **Don't branch discharge per source** — `'planctl'` discharges via the same Commit path as `'tool'`/`'bash'`.
- **No wall-clock in the fold** — `last_mutation_at = event.ts`.
- **Guard `Array.isArray(files) && length>0`** (read-only ops carry `files: null`/`[]`); normalize-or-skip non-relative paths so the mint tuple matches the dirty/commit tuple.

## Docs gaps

- **CLAUDE.md** event-sourcing invariants: fold a `planctl_op` arm into the `file_attributions` fan-out bullet; fix the drifted schema-version number (real `SCHEMA_VERSION=43`, this lands at the next free int).
- **README.md**: add `planctl` to the source-badge taxonomy (~:108, ~:617, ~:1226) + a sentence in the schema-v31 attribution narrative (~:803-842).
- **keeper/api.py**: `SUPPORTED_SCHEMA_VERSIONS += new version` (whitelist-only; keeper-py reads neither table).

## Alternatives

- **Derive paths from (op, epic_id, task_id)** instead of lifting `files`: rejected — provably incomplete (scaffold's task JSONs + all specs + meta.json lack an id column; live data confirms).
- **Exclude `.planctl` from the orphan surface**: rejected by the human in favor of honest attribution.
- **Forward-only (no backfill)**: residual historical orphans heal only as each file is next touched — slower to a clean surface; backfill+re-fold chosen for an immediately-clean burn-in.

## Architecture

planctl_op event (carries `files`, `state_repo`) → hook deriver lifts `files`
into `events.planctl_files` → reducer fold (gated `planctl_op != null`) mints
`file_attributions(project_dir=state_repo, session_id, file_path, source='planctl', last_mutation_at=event.ts)`
→ next GitSnapshot's pass-1/pass-3 render it instead of orphaning → the
`chore(planctl)` Commit discharges it via `foldCommit`.

## Rollout

Verify the mint + orphan-drop on a DB copy first. The `source`-CHECK table
rebuild + the `planctl_files` backfill + cursor-0 re-fold are the risky steps
— prove byte-identical re-fold on the copy before touching the live daemon.
Deploy via a keeperd bounce (paced boot from fn-659 bounds the re-fold).
Rollback: the mint is additive; reverting the fold path stops new planctl
attributions (existing rows are inert).
