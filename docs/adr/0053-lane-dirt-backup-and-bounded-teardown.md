# 0053 — Lane dirt backup, bounded teardown, and identity-keyed ladder alignment

## Status

Accepted (provisional number; fan-in renumber per ADR 0020/0022 applies). Extends
[ADR 0016](0016-worktree-lane-lifecycle.md)-class worktree hygiene and the merge-time renumber
rule of [ADR 0020](0020-schema-version-renumber-at-merge-time.md); complements ADR 0031 (the
occupancy guards stay above every destroy path) and ADR 0052 (reaper reliability).

## Context

A lane the recover pass cannot losslessly tear down re-mints teardown-dirty stickies silently
forever: a corrupt years-old worktree registered to a different repository's `.git` pinned a
long-dead epic to the board, and orphaned closed-epic lanes starved dispatch until an operator
force-removed them by hand. Separately, lanes provisioned without `node_modules` fail lint
falsely and fake SHARED_BASE_BROKEN; `keeper plan epic rm` strands its epic's lanes and any
session cwd'd in them; and the merge-time ladder-renumber tool refuses the exact post-merge
union shape it exists for, because its alignment keys on version numbers alone — a lane file
that textually contains main's ladder plus one same-numbered local step makes main's own later
steps look like lane duplicates.

## Decision

- **Destruction is bounded, backed up, and single-owner.** Only the grace-gated recover pass
  destroys lanes; the finalize-path teardown failure degrades to a deferral, never a hard
  sticky. A lane may be force-removed ONLY when every leg holds: its epic is closed or
  tombstoned; its content is safe — the lane branch is positively an ancestor of the local
  default, or the epic was explicitly removed (the human discarded the work); no occupying job
  (ADR 0031) and no mid-merge residue; ownership is positively OURS (the lane's
  `--git-common-dir` resolves into this repo and its branch matches the lane convention); it is
  not locked; and the un-tearable state has persisted past an injectable grace keyed per lane
  path. Immediately before removal the cleanliness, ownership, and occupancy probes re-run in
  the same cycle (TOCTOU).
- **The dirt backup precedes the destroy and is the gate.** Tracked changes (staged + unstaged
  diffs) and untracked files (`ls-files --others --exclude-standard`) snapshot to the lane dirt
  spool — an env-overridable state directory shared by daemon and plan CLI, retained like
  dead-letters (operator-managed). A failed backup never destroys; a persistently failing
  backup mints its own page-once distress row. A restart may produce a second spool entry —
  accepted, no durable dedup state.
- **Foreign, ambiguous, and locked lanes are never destroyed.** They share one page-once
  distress class (detail names which), minted past the grace, cleared only by the producer
  level-trigger observing the lane gone — replacing the silent infinite re-mint.
- **Lanes are provisioned with a `node_modules` directory symlink** to the source checkout's
  when present (idempotent, skipped when absent) — realpath resolution makes this tsc/Bun-safe;
  the shared store stays single-platform by construction (same host).
- **`epic rm` tears down its epic's lanes across every touched repo** with the same
  backup-then-force discipline implemented plan-side (the plugin shells git against the shared
  branch convention and spool env — no daemon import, no RPC widening), skips and reports any
  lane that fails the safety legs, and reports torn-down lane paths in its envelope; live-session
  detection remains the daemon sentinel's job.
- **Ladder alignment keys on step identity (version + canonicalized body), not version order.**
  A lane step matching a main step's identity is shared regardless of position; only
  body-not-in-main steps are branch-local candidates, and provably additive-idempotent ones
  renumber to main-tail+1..+k with the fingerprint re-pinned. Same-version+same-body absorbs as
  shared; same-body at a different version still refuses for a human, as does every destructive
  step class.

## Consequences

Closed-epic lane dirt is recoverable from the spool rather than blocking teardown forever;
work-loss risk concentrates in the backup contract, which is why backup failure blocks
destruction. Unmerged lanes of closed epics surface to a human instead of quietly leaking or
being destroyed. The plan CLI carries a small duplicated git-shelling sequence (accepted over a
cross-boundary import or a widened RPC). The rebase tool now resolves the union-shaped merge
file mechanically; genuinely ambiguous duplicates still stop for a human.

## Amendment — path-positive absence survives incomplete enumeration

A teardown or backup distress row may clear despite an incomplete repo enumeration only when
its stored lane path independently resolves as absent (`ENOENT` or `ENOTDIR`). A present path or
any other probe error remains unknown and retains the row. Complete enumeration remains the
other positive absence witness, so one unenumerable repo cannot pin a confirmed-gone lane while
partial evidence can never clear a live lane.
