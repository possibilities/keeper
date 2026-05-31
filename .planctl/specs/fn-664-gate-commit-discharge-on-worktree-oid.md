## Overview

keeper's git surface renders a file as `<orphan>` (zero attributions, counted
in `git_status.orphaned_count`) when it was committed but is still dirty in the
worktree — the commit captured the *staged* blob while the worktree diverged
further (stage → re-edit without re-staging → commit). `foldCommit`
(`src/reducer.ts:2248`) discharges a session's attribution claim by stamping
`last_commit_at` for every path NAMED in a commit, with no check that the
committed blob actually equals the current worktree blob; the discharge filter
`last_mutation_at > COALESCE(last_commit_at, 0)` then retires the claim and the
still-dirty file orphans.

This epic makes discharge **content-aware**: freeze a worktree blob oid
(`git hash-object`, filter-correct) into every `GitSnapshot` dirty-file at
producer time, freeze a per-file committed blob oid into every `Commit` event,
and discharge a session's claim only when the committed blob equals the current
worktree blob. Prospective-only: old events predate the oids, so NULL-oid rows
fall back to the existing timestamp discharge and a cursor=0 re-fold reproduces
byte-identical projections.

First diagnosed live: `test/reducer.test.ts`, edited by
`work::fn-661-server-side-autopilot-reconciler.1` at 19:08:07, discharged by a
19:11:37 commit that captured the staged blob `ac08c8d5` while the worktree held
`2cd6a3b9` — orphaned. Capture + root-cause in
`~/docs/keeper-reliability/orphan-captures/20260531T231509Z-keeper/` and
`findings.md`.

## Quick commands

- `bun test test/reducer.test.ts` — discharge + orphan-rollup cases
- `bun test test/git-worker.test.ts` — producer payload shape (oids present)
- `bun test test/schema-version.test.ts` — keeper-py whitelist covers SCHEMA_VERSION
- Repro: stage a tracked file, edit it again without re-staging, commit, then
  `keeper git` — the file must NOT render as `<orphan>`.

## Acceptance

- [ ] A file committed-but-still-dirty (stage → re-edit → commit) retains its
      author attribution and does NOT count toward `orphaned_count`.
- [ ] Discharge still fires when the commit DID capture the worktree
      (`committed_oid == worktree_oid` → claim retired exactly as today).
- [ ] Pre-bump / NULL-oid events fall back to timestamp discharge; a cursor=0
      re-fold reproduces byte-identical `git_status` + `file_attributions`.
- [ ] No `git hash-object` / `git ls-tree` / FS probe inside any fold
      transaction — every oid frozen at producer (event-build) time.
- [ ] `SCHEMA_VERSION` bumped + keeper-py `SUPPORTED_SCHEMA_VERSIONS` updated in
      the same change; `test/schema-version.test.ts` green.

## Early proof point

Task that proves the approach: `.1` (producer + payload + schema plumbing). If
`git hash-object` cost on dirty-heavy trees or re-fold determinism is a problem,
it surfaces here — before any discharge-semantic change lands in `.2`.

## References

- `fn-661-server-side-autopilot-reconciler` (overlap) — same `src/reducer.ts`,
  `test/reducer.test.ts`, and `SCHEMA_VERSION` migration slot; it is the session
  that created the live orphan. Coordinate the version bump (use the next free
  integer; rebase the migration if fn-661 lands its bump first).
- `foldCommit` `src/reducer.ts:2248-2316`; discharge read predicate at
  `:1812` / `:1868-1881` / `:1934-1951` / `:1966-1973`; pass-1 UPSERT `:1768`.
- `CommitPayload`/`extractCommit` `src/derivers.ts:1182-1279`; `GIT_OID_RE` `:1199`.
- `ReducerDirtyFile`/`extractGitSnapshot` `src/reducer.ts:1047-1136`.
- git-worker: mtime/lstat loop `~57-77`, `parsePorcelainV2` `256-346`
  (oid fields currently discarded), `commitFiles` `530-576`, wire shapes
  `107`/`152`; `daemon.ts:1333-1341` lifts the commit message verbatim.
- porcelain v2 carries `hH` (HEAD) + `hI` (index) blob oids but NO worktree oid;
  worktree oid needs `git hash-object` (WITHOUT `--no-filters`, so clean/CRLF
  filters match the stored blob).

## Docs gaps

- **CLAUDE.md (=AGENTS.md)**: event-sourcing invariants bullet — revise the
  discharge-rule prose, the `Commit` + `GitSnapshot` payload shapes, and the
  schema-version line in place.
- **README.md**: `## Architecture` git-attribution narrative (~800-831, SQL
  comment ~1171-1175) — update payload shape + discharge rule.
- **keeper/api.py**: `SUPPORTED_SCHEMA_VERSIONS` frozenset + inline comment gain
  the new version entry in the same change.

## Best practices

- **Use `git hash-object` WITHOUT `--no-filters`:** the stored blob is the
  cleaned/CRLF-normalized bytes; a raw hash would never match `hH`/`hI`.
- **Freeze oids at producer time, never in the fold:** a fold-time git probe
  breaks re-fold determinism (re-fold sees different OS state). Same rule that
  already gates `mtime_ms`.
- **Per-file committed oids via `git diff-tree -r --no-commit-id <oid>`** (new
  hash = committed blob; handle initial-commit null parent).
- **Treat NULL worktree_oid (racy-clean / lstat miss / inferred / untracked) as
  "cannot confirm → keep attribution active"**, falling back to timestamp discharge.
