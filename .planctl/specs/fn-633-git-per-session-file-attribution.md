## Overview

Replace today's "live-only attribution → everything else is orphan" git surface with honest per-(session, file) attribution and a commit-based discharge rule. A session is attributed to a still-dirty file iff it has at least one mutation event on that file AND has not committed it more recently than its last mutation — editing puts you on the hook, committing what you edited takes you off, re-editing puts you back on. Bash-side mutations land in the hook as derived columns; remaining unattributed dirty files get inferred attribution via time-bracketing against Bash event intervals. A `git` PATH wrapper stamps a `Session-Id:` commit trailer on every Claude-session commit so the producer can resolve committer-session deterministically.

## Quick commands

```bash
# smoke test: trailer stamps end-to-end via the wrapper
cd /tmp/x && /usr/bin/git init -q && echo a > a && /usr/bin/git add a \
  && CLAUDE_CODE_SESSION_ID=test-uuid bun --bun plugin/bin/git -c user.email=t@t -c user.name=t commit -m "x" \
  && /usr/bin/git log -1 --format='%(trailers:key=Session-Id,valueonly,only,unfold)'

# smoke test: bash mutation deriver populates events
sqlite3 .keeper.db "SELECT bash_mutation_kind, bash_mutation_targets FROM events WHERE tool_name='Bash' AND bash_mutation_kind IS NOT NULL LIMIT 5;"

# smoke test: file_attributions populated, discharge clears
sqlite3 .keeper.db "SELECT file_path, session_id, last_mutation_at, last_commit_at FROM file_attributions LIMIT 20;"

# smoke test: git_status carries attributions per file
sqlite3 .keeper.db "SELECT json_extract(dirty_files,'$[0]') FROM git_status LIMIT 1;"

# client renders multi-attribution
bun scripts/git.ts
```

## Acceptance

- [ ] `plugin/bin/git` wrapper stamps `Session-Id:` trailer on every `git commit ...` invocation when `CLAUDE_CODE_SESSION_ID` is set in env; non-commit invocations pass through unmodified
- [ ] Schema v30→v31 migration adds `events.bash_mutation_kind`, `events.bash_mutation_targets`, `jobs.git_unattributed_to_live_count`, redefines `jobs.git_orphan_count` to strict-mystery semantic, creates `file_attributions` table with two indexes
- [ ] Same-transaction backfill re-derives `bash_mutation_*` on every stored Bash event row
- [ ] Version-guarded rewind (last_event_id=0, DELETE FROM jobs/epics/git_status/file_attributions) followed by full re-drain repopulates all projections byte-deterministically
- [ ] `Commit` synthetic event emitted by git-worker on HEAD-oid change, carries `{project_dir, commit_oid, parent_oid, files, committer_session_id}`; trailer-less → null → global discharge
- [ ] `GitSnapshot` payload widens to file-centric: each dirty file carries `{path, xy, mtime_ms, ...}` plus the producer-computed dirty file list; reducer attribution pass joins event log + payload to compute `attributions[]` inside `BEGIN IMMEDIATE`
- [ ] `file_attributions` table maintained inside the same `BEGIN IMMEDIATE` as cursor advance + jobs/epics fan-out; discharge updates `last_commit_at`, not row deletes; symmetric retract on `GitRootDropped`
- [ ] Readiness predicate 6.5 (task path + close path) reads `git_unattributed_to_live_count` instead of legacy `git_orphan_count`
- [ ] `scripts/git.ts` renders file-centric layout with source-badged multi-attribution per file (`tool`/`bash`/`inferred`); board/autopilot column rename lands without functional regression
- [ ] README + CLAUDE.md updates: sparse-columns count, schema-version chronicle, git collection description, DO-NOT enumeration of synthetic events (now includes `Commit`)

## Early proof point

Task that proves the approach: `<epic>.6` (projectGitStatus attribution rewrite). If it fails or the design is wrong, the discharge rule + file_attributions shape break before any client work lands. Recovery plan if it fails: revert to embedding `attributions[]` inside `git_status.dirty_files[]` JSON without the separate facts table — keeps the file-centric projection shape but loses the indexable per-(session, file) view.

## References

- Original /arthack:sketch sketch (saved as bundle `sketch/git-surface-rewrite-per-session-attribution`)
- fn-625 / fn-626 (both `done`): recent predicate 6.5 fixes — context only, no conflict
- fn-632 (in-progress, no file overlap): safe to land in parallel
- Empirical wrapper verification: `CLAUDE_CODE_SESSION_ID` is natively exposed by Claude Code 2.x; PATH injection works via `plugin/bin/` (already first in keeper's PATH at position 34); `jobctl commit-work` uses bare `["git", ...]` subprocess calls so wrapper interception is transparent
- Practice-scout findings: git 2.32+ canonical trailer extraction is `%(trailers:key=Session-Id,valueonly,only,unfold)`; `--trailer` flag uses `addIfDifferentNeighbor` so amend doesn't duplicate

## Docs gaps

- **README.md "What keeper is" paragraph (lines 97–99)**: rewrite the `git` collection description for file-centric shape with multi-attribution
- **README.md "Example clients" git.ts entry (lines 436–455)**: collapse old framing, describe new attribution rendering
- **README.md Architecture sparse-columns count (line 503)**: update count + extend list with `bash_mutation_kind`, `bash_mutation_targets`
- **README.md schema-version chronicle (lines 563–597)**: add v31 clause for events widening + jobs rename/add + file_attributions table
- **README.md Inspect section**: optionally add a `git_status` / `file_attributions` query example
- **CLAUDE.md sparse-columns enumeration**: add the two new bash_mutation_* columns
- **CLAUDE.md DO-NOT list synthetic events by name**: add `Commit` alongside `TranscriptTitle`, `EpicSnapshot`, `TaskSnapshot`, `Killed`, etc.

## Best practices

- **`git commit --trailer "..."` (git 2.32+, default `addIfDifferentNeighbor`):** idempotent on amend with identical trailer — no extra `git interpret-trailers --if-exists doNothing` needed. Source: git man page, verified empirically.
- **Don't `stat()` inside `BEGIN IMMEDIATE`:** WAL writer block. Producer stats every dirty file at snapshot build time and embeds mtime in the payload; reducer does pure-SQL attribution joining against frozen-in-payload mtimes — re-fold deterministic.
- **Module-scope regex literals + defensive null returns in derivers** (`src/derivers.ts:1-39` precedent): hook cold-start budget is ~30ms with 1.5s SessionEnd timeout, no JSON-parse of `tool_response.stdout` without a startsWith fast-path gate, no third-party imports.
- **Hardcode canonical lockfile paths per package manager** (not from arg parsing): pnpm-lock.yaml/package-lock.json/yarn.lock/bun.lockb/Cargo.lock/uv.lock/poetry.lock anchored on git-root, not cwd. Manifest dirs anchored on cwd at hook write time.

## Snippet context

Bundles inherited for this epic:
- `sketch/git-surface-rewrite-per-session-attribution` — full direction and conversation context from the /arthack:sketch that preceded this plan
