## Overview

A blind multi-model panel reviewed the fn-997 durable per-job worktree-marker
implementation and confirmed it correct + non-regressive (re-fold determinism,
NULL=absent, always-emit env, lockstep all verified), with a handful of minor,
non-blocking residuals. This closes them: synthetic event inserts don't explicitly
bind the new `worktree` column (safe today via bun's missing-param->NULL, but it
breaks the explicit-every-column convention and is fragile if bun tightens); the
jobs pill glyph is inconsistent between the renderer and a comment; a fold comment
misstates the resume mechanism; and the no-backfill-for-pre-v94-in-flight-jobs
behavior is undocumented. All cosmetic / doc / robustness — NO behavior change.

## Quick commands

- `bun run test` — the real gate (must stay green, byte-identical fold)

## Acceptance

- [ ] every synthetic event insert binds `worktree` explicitly (NULL), matching the config_dir/mutation_path convention — no reliance on missing-param->NULL
- [ ] the jobs worktree pill uses ONE glyph consistently across renderer + comments/docs
- [ ] the reducer set-once `worktree` COALESCE comment accurately describes resume (re-injects the same branch; COALESCE safe either way), not "a resume sends NULL"
- [ ] the no-backfill-for-pre-v94-in-flight-jobs behavior is documented (jobs running before v94 keep worktree=NULL for life — expected, not a bug)
- [ ] `bun run test` stays green; no behavior change to the marker fold/capture

## References

- From the fn-997 panel review: R3 (synthetic-insert parity), R5 (pill glyph), R2 (fold comment accuracy), and the in-flight-at-deploy doc gap. The marker feature itself shipped correct and v94 is live; these are residual cleanups only. R4 (the closed fn-997 spec's rib-format text) is intentionally out of scope — archival, and the code/README are already correct (double-dash `keeper/epic/<id>--<task>`).
