## Description

Addresses F1 (+ merged F5). `remotePushFastForwardable`
(src/worktree-git.ts:554-567) returns `false` for BOTH a diverged
`origin/<default>` and an unresolved one (line 563-564). The finalize
path (src/autopilot-worker.ts:2593-2601) and the recover mirror
(:2913-2916) run that FF check before the `remotePushTurnKey` probe
(:2610-2617), so a never-pushed-default repo (origin configured, no cached
`origin/<default>` ref) degrades every cycle to
`worktree-finalize-non-fast-forward` with the reason "origin/<default> is
ahead of <default>" — factually wrong (the ref is absent, not ahead) — and
the only way to create the ref is the very push being skipped. The
docstring at :550-552 already claims the turn-key probe "catches the
never-pushed case before the merge," which the actual call order
contradicts.

Distinguish "unresolved ref" from "origin ahead" so the never-pushed-
default case reaches the turn-key dry-run (the authoritative gate for a
legitimate first push) and the emitted skip reason is accurate. F5 folds
in: add an end-to-end test for a repo with origin + `@{push}` but no cached
default ref, asserting it does NOT jam on the non-ff reason.

## Acceptance

- [ ] A never-pushed-default repo (origin + `@{push}`, no cached `origin/<default>`) completes its first finalize push rather than jamming on `worktree-finalize-non-fast-forward`.
- [ ] The `non-fast-forward` skip reason is emitted only for a genuinely diverged remote, with accurate text; the recover mirror (:2913-2916) gets the same treatment.
- [ ] An end-to-end test covers the never-pushed finalize path (not just the helper return); the existing fast and slow tiers stay green.
- [ ] The src/worktree-git.ts:550-552 docstring matches the actual probe order.

## Done summary

## Evidence
