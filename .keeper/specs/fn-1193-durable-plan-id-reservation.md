## Overview

A `keeper plan` mint is reserved by nothing more durable than working-tree files
until its pathspec auto-commit lands, and that commit is guaranteed to fail during
any merge window in the shared checkout — leaving staged files a `git merge --abort`
silently destroys, after which the number gets re-minted by a concurrent flow (the
fn-1183 incident). This epic makes the collision impossible-by-construction on the
minting host and loud everywhere else: mutating verbs fail fast before writing when
the state repo is mid-operation, the write→commit window serializes on the shared
commit-work flock, any commit failure rolls the working tree back to a no-op, id
allocation consults a durable host-local id ledger, duplicate numbers surface as
mint-time refusals plus a board distress row, and the escalation abort surfaces
learn to preserve foreign staged files. Decision record: docs/adr/0023.

## Quick commands

- `cd plugins/plan && bun test` — fast plan suite (fake VCS, zero real git)
- `cd plugins/plan && bun run test:slow` — real-git tier (KEEPER_PLAN_RUN_SLOW=1): merge-window fast-fail, rollback, flock serialization
- `bun test test/` — root fast suite for the daemon-side detection/defer arms
- `bun scripts/lint-claude-md.ts` — CLAUDE.md guardrail additions stay under the size gate

## Acceptance

- [ ] A mutating plan verb invoked while the state repo has a merge/cherry-pick/revert/rebase in progress writes nothing and emits a typed retryable `merge_in_progress` envelope
- [ ] A plan auto-commit failure leaves the working tree exactly as the verb found it — nothing staged, no orphan files — and the failure envelope stays authoritative
- [ ] Destroying a minted epic's or task's working-tree files cannot cause the same number to be re-allocated on the same host
- [ ] A same-project duplicate bare number is refused at mint, surfaces as a needs-human distress row if it lands anyway, and bare `fn-N` resolution refuses ambiguity instead of returning the first match
- [ ] The recover pass defers its automated merge abort while foreign non-conflict paths are staged in the shared checkout

## Early proof point

Task that proves the approach: `.1` (sequencer-state probe + sync deadline flock over the FFI primitives, in both real and fake VCS). If it fails: drop the shared-lock layer to probe+rollback-only and re-scope task .2 accordingly — the probe and rollback layers alone still remove the destruction window.

## References

- docs/adr/0023-durable-plan-id-reservation.md — the decision record this epic implements
- docs/adr/0008-plumbing-base-default-merge.md — the working-tree-free base merge this extends; records the motivating incident class
- docs/adr/0020-schema-version-renumber-at-merge-time.md — the rejected renumber-at-land shape
- docs/problem-codes.md — Plan-family envelope registry; `merge_in_progress` is a new commit-time retryable class, `id_collision` gets reused (not duplicated) for the mint guard
- CONTEXT.md — the Id ledger glossary term (avoid "high-water" wording; it collides with Lifecycle stamp)
- `fn-1182` (overlap) — its task .2 rewrites the deconflict SKILL + resolver-charter wording in src/daemon.ts, the same surfaces task .6 edits; its .3 teaches a singleton-resource overlap signal conceptually parallel to task .5
- `fn-1180` (overlap) — its in-flight task .3 edits cli/board.ts, the same render surface as task .5
- `fn-1190` (overlap) — its in-flight task .1 unstages `done` bytes on the same commit.ts staging seam task .3 generalizes; whoever lands second inherits the merged contract, and .3 must not regress its fix

## Docs gaps

- **docs/problem-codes.md**: revise the Plan-family preamble (currently "before any commit") to admit the commit-time retryable class; add `merge_in_progress`; reconcile duplicate-number detection with the existing `id_collision` row — task .2/.4 deliverables
- **CLAUDE.md**: two one-line guardrails, size-gate permitting — allocation is max(scan, ledger)+1 never bare scan; the id ledger's sole writer folded into the existing Sole-writer rules bullet — task .4 deliverable

## Best practices

- **Probe every in-progress state, not just MERGE_HEAD:** the partial-commit refusal also fires during cherry-pick/revert/rebase, and mid-sequence `CHERRY_PICK_HEAD` can be absent — check `.git/sequencer/todo` too [git docs]
- **EAFP — the commit is the authority:** the probe is best-effort UX; TOCTOU is inherent, so the design must be safe under a stale probe (CWE-367) [practice-scout]
- **Tiny exclusive critical section:** acquire LOCK_EX from the start (never upgrade), deadline-bounded LOCK_NB poll with jitter, distinguish timeout (retryable) from lock-fd IO error [apenwarr]
- **Ledger append = one O_APPEND write() of one bounded JSON line**, newline-injection-safe; tolerate a corrupt trailing record on read (crash-truncated tail degrades to scan); skip per-mint fsync — the scan is the durability backstop [pvk.ca]
- **Never delete a foreign `.git/index.lock`** — treat as contention, retry [git internals]
