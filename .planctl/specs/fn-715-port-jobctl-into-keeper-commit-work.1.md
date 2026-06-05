## Description

**Size:** M
**Files:** cli/keeper.ts, cli/commit-work.ts (stub), cli/find-task-commit.ts (stub), cli/session-state.ts (stub), cli/show-session-files.ts (stub), src/commit-work/git-exec.ts (new), src/commit-work/flock.ts (new), src/commit-work/attribution.ts (new), src/commit-work/session-id.ts (new), test/commit-work-foundation.test.ts (new)

### Approach

Build the shared TS primitives the four subcommands need, and wire the
dispatcher once so later subcommand tasks touch only their own
`cli/<sub>.ts` module (disjoint, parallel-safe). Four primitives:
(1) a write-capable git spawn helper — `Bun.spawn` array-form, `shell:false`,
concurrent stdout+stderr drain via Promise.all, NO `--no-optional-locks`
(that flag is for the daemon's read probes and defeats index refresh on
writes); (2) an `flock(2)` primitive via Bun FFI `dlopen(libc)` — `LOCK_EX`,
then `fcntl(fd, F_SETFD=2, FD_CLOEXEC=1)`, return type `FFIType.i32`, lock
path `$(git rev-parse --git-common-dir)/keeper-commit-work.lock`; (3) the
attribution reader porting `get_session_dirty_files` (keeper/api.py:392):
`SELECT project_dir,file_path FROM file_attributions WHERE session_id=? AND
(last_commit_at IS NULL OR last_commit_at < last_mutation_at)`, intersect a
LIVE `git status --porcelain=v2 -z --untracked-files=all` per repo
(FAIL-OPEN if git unreadable), resolve cwd_repo via live `git rev-parse
--show-toplevel`, then reapply the CLIENT-side `.planctl/` exclusion (NOT in
the DB query); (4) session-id resolution env-only (arg → `JOBCTL_SESSION_ID`
→ `CLAUDE_CODE_SESSION_ID`; drop the Python psutil ancestor walk — no TS
equivalent, and `CLAUDE_CODE_SESSION_ID` is set in every real session).
Read the DB natively via `openDb({readonly:true})`; do NOT re-assert
`SUPPORTED_SCHEMA_VERSIONS` — keeper owns the schema in the same binary, so
a hardcoded TS whitelist would self-reject the moment SCHEMA_VERSION bumps.
Then extend the `cli/keeper.ts` `SUBCOMMANDS` tuple + `USAGE` + lazy-import
handler map with all four verbs, each pointing at a stub `cli/<sub>.ts` that
exports `main(argv)` (throws "not implemented" for now) and neutralizes its
`import.meta.main`.

### Investigation targets

**Required** (read before coding):
- ~/code/keeper/keeper/api.py:315-449 — the exact attribution + live-git + fail-open algorithm to port
- ~/code/keeper/cli/keeper.ts:26-136 — dispatch factory shape (SUBCOMMANDS tuple, USAGE, lazy import handler map)
- ~/code/keeper/src/db.ts:69,5398 — resolveDbPath(), openDb readonly contract + PRAGMAs
- ~/code/keeper/src/git-worker.ts:600,1781 — gitOutput spawnSync idiom + stdin-piped variant (model, do NOT reuse for writes)
- ~/code/arthack/apps/jobctl/jobctl/helpers.py — resolve_session_id precedence, discover_files, filter_gitignored (git check-ignore -z --stdin, fail-open ≥128)

**Optional** (reference as needed):
- ~/code/keeper/cli/git.ts:1-53 — subcommand module head scaffolding (HELP block, parseArgs, main shape)
- Bun FFI docs (dlopen/libc), flock(2) man page (exec inheritance semantics)

### Risks

- flock FFI on macOS aarch64: wrong return type segfaults; missing FD_CLOEXEC leaks the lock into spawned children (lock never releases until they exit). Both are silent-corruption bugs — assert them in tests.
- Attribution fail-open must be PER-REPO: a transient `git status` failure keeps all on-hook files (fail-OPEN), never drops them (fail-closed → empty commit, lost attribution).
- `.planctl/` exclusion is client-side; forgetting it re-orphans planctl files.

### Test notes

Unit-test the attribution reader against a temp git repo + sandboxed
`KEEPER_DB` (per CLAUDE.md isolation rule — route all four state paths
through the base-env helper). Assert the flock primitive acquires/releases
and that a second acquire blocks. Assert dispatcher routes the four new
verbs (extend the makeHarness SUBCOMMANDS loop in test/keeper-cli.test.ts).

## Acceptance

- [ ] Write-capable git helper drains both streams concurrently and omits `--no-optional-locks`.
- [ ] flock primitive: LOCK_EX on `$GIT_COMMON_DIR/keeper-commit-work.lock`, fd marked FD_CLOEXEC, i32 FFI return; second concurrent acquire blocks.
- [ ] Attribution reader reproduces `get_session_dirty_files` output on a fixture repo (per-repo fail-open, cwd_repo resolution, `.planctl/` excluded).
- [ ] session-id resolves arg → JOBCTL_SESSION_ID → CLAUDE_CODE_SESSION_ID; reads DB via `openDb({readonly:true})` with no whitelist re-assertion.
- [ ] cli/keeper.ts dispatches all four new verbs to stub modules; `pnpm lint` + `pnpm typecheck` green.

## Done summary

## Evidence
