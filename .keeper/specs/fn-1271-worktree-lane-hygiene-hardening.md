## Overview

Four lane-lifecycle defects from the 2026-07-12/13 drain, resolved per ADR 0053: the recover
pass stops silently re-minting on un-tearable lanes (backup-then-force for closed epics'
merged/tombstoned lanes, page-once for foreign/ambiguous/locked); lanes get a node_modules
symlink at provision; epic rm tears down its own lanes; and the merge-time ladder tool
resolves the post-merge union shape mechanically. End state: no lane can pin a dead epic or
starve dispatch silently, and no fan-in schema collision needs a hand-renumber.

## Quick commands

- `bun test test/worktree-git.test.ts test/autopilot-worker.test.ts test/rebase-schema-migration.test.ts` — teardown/provision/alignment surfaces green
- `cd plugins/plan && bun test test/saga-epic-rm.test.ts` — rm teardown envelope green

## Acceptance

- [ ] An un-tearable lane of a closed epic is backed up to the lane dirt spool and force-removed past the grace; a foreign, ambiguous, or locked lane pages once and is never destroyed; the silent per-cycle re-mint is gone
- [ ] A newly provisioned lane resolves tsc/biome through a node_modules symlink to the source checkout
- [ ] `keeper plan epic rm` removes its epic's lanes (all touched repos) with the same discipline and reports torn-down/skipped lanes in its envelope
- [ ] The rebase tool renumbers a different-body branch-local step colliding on a main-used version (the union shape) and re-pins the fingerprint; destructive and genuinely-ambiguous cases still refuse

## Early proof point

Task that proves the approach: ordinal 1 (identity-keyed ladder alignment) — pure string-in/
string-out with a recorded live repro; if the identity model fails there, re-scope to a
documented hand-recipe and drop ordinal 1 only.

## References

- docs/adr/0053-lane-dirt-backup-and-bounded-teardown.md (the decision record; extends 0020, complements 0031/0052)
- CONTEXT.md: Recover pass (revised), Lane dirt spool (new), Phantom-working (the hazard destroyed-cwd creates — use this term, never "zombie")
- docs/adr/0020-schema-version-renumber-at-merge-time.md (trunk-keeps-numbers rule the tool implements)

## Docs gaps

- **CLAUDE.md**: revise the Autopilot recover-pass invariant clause in place when the code lands (destroy-with-backup vs page-once split; keep lint-claude-md green) — owned by ordinal 2
- **CLAUDE.md test-isolation line**: the state-class enumeration gains the lane-dirt-spool env — owned by ordinal 2

## Best practices

- **Ownership via git-common-dir, never path heuristics:** a linked worktree's .git FILE points at the owner's .git/worktrees/<name>; elsewhere = foreign = never destroy [git-scm]
- **Filesystem-level dirt snapshot, not stash:** staged+unstaged diffs + `ls-files --others --exclude-standard`; stash is a clearable stack, not a backup
- **Locked worktrees need --force --force:** a lock is a human signal — page, never double-force
- **TOCTOU:** re-check cleanliness/ownership/occupancy inside the destroy op, not only at grace-start
- **Content-hash step identity, version as ordering hint:** the Alembic/django-linear-migrations model for ladder alignment
