## Description

Originating finding F1 (with F4 merged). Evidence path:
`src/gated-roots.ts:94-126` — both `unseededGatedRoots` and
`allGatedRootsSeeded` query `SELECT 1 FROM git_status WHERE project_dir = ?`
with the RAW gated `effectiveRoot`, while `src/git-boot-seed.ts:172`
(`discoverSeedRoots`) writes `git_status` rows keyed by
`resolveGitToplevel(candidate)`. The raw-key lookup only matches when the
gated root is already its own git toplevel. fn-905's self-clear lifecycle
makes a key mismatch a PERMANENT wedge (the root never clears
`seed_required` and stays forced-`unknown`), where the pre-fn-905 mutex
tolerated it as a transient stall.

Add a one-line invariant comment at the raw-key lookup site in
`src/gated-roots.ts` stating that gated roots MUST already be git toplevels,
keyed identically to `git_status.project_dir` (the live git-worker /
boot-seed write key) — so the next reader knows the raw-key lookup is
load-bearing on an unstated upstream guarantee.

F4 (merged): a synthetic test that inserts a `git_status` row under a
RESOLVED key while gating on a RAW key would prove the lookup behavior is
intentional — OPTIONAL belt-and-suspenders, default-tier and git-free per
the no-real-git rule (synthetic row insert, no `resolveGitToplevel`
execution). Add it only if it reads as documentation of the invariant
rather than a test of a non-occurring scenario; the comment is the primary
deliverable.

## Acceptance

- [ ] An invariant comment at the raw-key lookup in `src/gated-roots.ts`
      states gated roots MUST already be git toplevels, keyed identically
      to `git_status.project_dir`.

## Done summary

## Evidence
