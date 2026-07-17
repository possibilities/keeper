# 0074 — Lane residue policy and universal dep provisioning

Status: Accepted (provisional number; renumber at fan-in)

## Context

Worktree lanes cannot run suites without dependencies, so keeper plants
`node_modules` symlinks into the lanes it creates. Teardown treats untracked
files in a dying lane as potential work product — snapshot to the lane dirt
spool before force-removal — which is right for real work and wrong for
keeper's own plants: "untracked" cannot mean "spool-worthy" when keeper itself
made the file. Meanwhile baseline and recovery worktrees receive no
provisioning at all, so baseline suites crash red on missing imports and
poison failure attribution: a worker diffing its failures against a
missing-deps-red baseline cannot separate its breakage from the environment's.

## Decision

- **Provisioning is universal.** Every keeper-created worktree of a repo —
  task lanes, epic bases, baseline worktrees, recovery worktrees — receives
  the same dependency-symlink provisioning at creation, through the one
  provisioning seam. Environmental identity across managed worktrees is what
  failure attribution assumes; now it holds.
- **Teardown classifies by byte-identity, never by name.** An untracked entry
  is keeper-planted residue only when it is exactly what the provisioning seam
  creates — same link type, same target. Matches delete freely without
  spooling. Everything else keeps the spool-first discipline, including a
  formerly-provisioned path whose content was replaced: no longer identical
  means work product, so it spools.
- **One seam owns both sides.** The identity test lives beside the
  provisioning code so what keeper plants and what teardown recognizes cannot
  drift apart.

## Consequences

The missing-deps red-baseline class ends, and spool snapshots stop carrying
keeper's own symlinks. A repo whose dependency layout changes updates the one
provisioning seam and the identity test moves with it. Full installs per
worktree were considered and rejected: hermetic but slow, and unnecessary on a
single host where every managed worktree may share the root checkout's
install.
