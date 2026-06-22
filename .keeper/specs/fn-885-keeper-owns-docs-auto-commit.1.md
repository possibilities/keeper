## Description

**Size:** M
**Files:** src/doc-commit.ts (new, dep-free), plugins/keeper/plugin/hooks/sidecar-writer.ts (extend), plugins/keeper/hooks/hooks.json (widen PostToolUse matcher), test/doc-commit.test.ts (new), test/sidecar-writer.test.ts (extend)

### Approach

Port the commit machinery of `plugins/plan/src/commit.ts` into a NEW dep-free `src/doc-commit.ts` (a keeper hook must NOT import the plan plugin; `commit.ts` uses only `Bun.spawnSync` so the port is mechanical). Then extend the fn-884 sidecar-writer hook: after it writes the `.yaml` sidecar, commit the dirty `~/docs` paths. Derive paths from `src/derivers.ts` — `extractMutationPath` for Write/Edit/MultiEdit, `extractBashMutation` (filter targets to those under `~/docs`) for `rm`/`mv`/`git rm` deletes. Commit pathspec-scoped (`git commit -F - -- <files>`), no-op when `dirtyFilesForPathspecs` is empty, mechanical message `docs: write|update|delete <relpath>`.

Port adjustments for the hook context (differ from the plan committer): tighten the bounded retry cap to ~4 attempts (the plan default's ~16s worst-case is too long to block a per-write turn); pass `-c commit.gpgsign=false` (a global `commit.gpgsign=true` would wedge the non-interactive commit — this is a mechanical personal-docs commit, not a source commit, so signing is intentionally off); add a subprocess timeout to every git call (a hung git must not stall the turn); guard mid-operation repo state (skip if `MERGE_HEAD`/`CHERRY_PICK_HEAD`/`rebase-merge`/`rebase-apply`/`BISECT_LOG` present) and detached HEAD (`git symbolic-ref -q HEAD`). FAIL-OPEN: catch `CommitFailed` (the port throws) and exit 0 — a commit failure must never abort the already-succeeded sidecar write or wedge the session.

Widen the hooks.json PostToolUse matcher to include Edit/MultiEdit (it is Write+Bash today, so edits would silently never commit). Do not touch the events-writer `*` entry.

### Investigation targets

**Required:**
- plugins/plan/src/commit.ts:70-154,225-348 — runGit, dirtyFilesForPathspecs, gitStage, gitCommit, the retry loop + constants, CommitFailed (port these dep-free)
- src/derivers.ts (extractMutationPath ~171, extractBashMutation ~904, tokenizeShell ~691)
- plugins/keeper/plugin/hooks/sidecar-writer.ts (fn-884) — the exit-0 outer guard + ~/docs gate to extend
- plugins/keeper/hooks/hooks.json — PostToolUse matcher set
- test/helpers/git-repo.ts initRepo — real-git tmp fixture (gpgsign false)

### Risks

- Re-entrancy is safe (git is not a Claude tool — the hook's git child does not re-fire the hook).
- extractMutationPath returns ANY path → gate on `~/docs` before committing.
- Commit the `.md` + `.yaml` together when both are dirty (Write); on Edit only the `.md` is dirty — `dirtyFilesForPathspecs` naturally scopes it.

### Test notes

`test/doc-commit.test.ts`: unit-test the ported committer over an `initRepo` tmp repo (commit lands, no-op when clean, retry on simulated lock, skip on detached HEAD / mid-merge). Extend `test/sidecar-writer.test.ts`: a Write under `KEEPER_DOCS_DIR` produces a commit; a non-`~/docs` write does not; exit 0 on a non-repo docs dir. `bun run test:full` before landing.

## Acceptance

- [ ] `src/doc-commit.ts` is dep-free (node:fs/os/path + Bun.spawnSync only; no plan-plugin import, no bun:sqlite/db.ts)
- [ ] Write/Edit/MultiEdit/delete under `~/docs` commits the right pathspec with a mechanical message; clean tree is a no-op
- [ ] guards: detached HEAD + mid-operation repo state skip cleanly; gpgsign disabled; per-call git timeout; tightened retry cap
- [ ] hook exits 0 on commit failure / non-repo / malformed payload; PostToolUse matcher includes Edit/MultiEdit
- [ ] tests pass; `bun run test:full` green

## Done summary

## Evidence
