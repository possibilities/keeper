## Description

**Size:** S
**Files:** plugins/keeper/plugin/hooks/docs-pusher.ts (new), plugins/keeper/hooks/hooks.json (append Stop entry), test/docs-pusher.test.ts (new), CLAUDE.md, README.md

### Approach

Add a `Stop` hook that pushes `~/docs` to its remote on a debounced cadence — Stop fires once per turn, which IS the debounce, so no persistent timer state is needed. Steps: resolve `~/docs` (honor the same `KEEPER_DOCS_DIR` override as the committer); guard mid-operation repo state + detached HEAD; check ahead-of-upstream with `git rev-list --count @{u}..HEAD` (use `@{u}`, not a hardcoded `origin/main`, to survive a non-main branch; exit 0 if 0 or no upstream); acquire a push lockfile under `.git/` (`set -o noclobber` style) so concurrent sessions don't race — skip if locked; push with a subprocess timeout; on non-fast-forward / auth / network failure LOG to a file (not stderr) and SKIP — never auto-rebase, never `--force`. EXIT 0 ALWAYS: a Stop hook that exits 2 PREVENTS Claude from stopping, so every path must end exit 0 with all errors swallowed+logged.

Append a second command entry to the EXISTING `Stop` block in hooks.json (the Stop block has NO matcher key — match that shape; do not touch the events-writer entry).

Update docs forward-facing, starting from fn-884's revised baseline: keeper CLAUDE.md "Hook rules" (the docs sidecar hook now also commits, and a new Stop pusher pushes — coordinate with fn-884's two→three-hook rename) + "Process & DB-watch invariants" (a hook spawns a git subprocess; the debounced-push flush strategy); README `## Architecture` hook paragraph + plugin install step; the hooks.json `description` string.

### Investigation targets

**Required:**
- plugins/keeper/hooks/hooks.json — the existing Stop block shape (no matcher)
- src/commit-work/push.ts — `classifyPushError` substrings + `@{u}` upstream detection (reuse the SUBSTRINGS only; it is async/dep-heavy, NOT hook-portable — write a small dep-free sync push in the hook)
- test/commit-work.test.ts addBareOrigin + test/helpers/git-repo.ts initRepo — push-test scaffolding
- keeper CLAUDE.md "Hook rules" / "Process & DB-watch invariants"; README.md ## Architecture hook paragraph + install step

### Risks

- Stop exit 2 is catastrophic (blocks Claude stopping) — exit 0 on every path is mandatory.
- Don't `git fetch` in the pusher (per-turn network cost) — `@{u}..HEAD` is a local count.
- Concurrent-session push race → lockfile; non-ff → log+skip, never rebase/force.

### Test notes

`test/docs-pusher.test.ts` over `initRepo` + `addBareOrigin`: pushes when ahead; no-op when not ahead / no upstream; non-ff logs and skips; exits 0 on a push failure; lockfile prevents a second concurrent push. `bun run test:full` before landing.

## Acceptance

- [ ] Stop with local ahead of `@{u}` pushes `~/docs`; nothing-ahead and no-upstream are clean no-ops
- [ ] non-fast-forward / auth / network failure → logged to a file + skipped (no rebase, no --force); push lockfile serializes concurrent sessions
- [ ] hook exits 0 on every path (push failure, mid-op repo, detached HEAD, hung git via timeout)
- [ ] docs updated forward-facing (CLAUDE.md hook rules + invariants, README architecture + install, hooks.json description), from fn-884's baseline
- [ ] tests pass; `bun run test:full` green

## Done summary

## Evidence
