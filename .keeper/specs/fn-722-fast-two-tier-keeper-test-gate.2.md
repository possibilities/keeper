## Description

**Size:** M
**Files:** test/helpers/sandbox-env.ts (new), test/helpers/git-repo.ts (new), test/helpers/retry-until.ts (new), test/commit-work.test.ts, test/find-task-commit.test.ts, test/session-state.test.ts, test/events-writer.test.ts, test/integration.test.ts, CLAUDE.md, README.md

### Approach

Create `test/helpers/` (does not exist today). Land three shared helpers and migrate consumers:
1. **sandbox-env.ts** — reconcile the TWO existing shape-families into one module. Family A (id-clearing CLI-spawn, byte-identical in commit-work:64 / find-task-commit:52 / session-state:51) clears CLAUDE_CODE_SESSION_ID/JOBCTL_SESSION_ID/JOBCTL_JOB_ID and sets 5 KEEPER_* paths. Family B (`sandboxedBaseEnv()` in events-writer:111 / integration:189) does NOT clear ambient ids and adds a SIXTH var KEEPER_ZELLIJ_EVENTS_DIR (fn-684). Export a parameterized core `sandboxEnv({ tmpDir, dbPath, clearAmbientIds?, includeZellij?, extra? })` (state paths applied LAST, after the extra-merge and undefined-clear, per the isolation invariant) — or two thin named wrappers over a shared core. Migrate all five files. Do NOT touch backstop-telemetry/restore-worker/restore-agents/refold-progress — they set single env vars directly and must stay as-is.
2. **git-repo.ts** — a shared `initRepo(dir)` running `git init -q -b main` + `config user.email/name` + `config commit.gpgsign false` (the byte-identical sequence in every fixture). Used by task 4.
3. **retry-until.ts** — lift the canonical `retryUntil(predicate, timeoutMs, cadenceMs)` from integration.test.ts:153; used by task 6.

Then update docs: CLAUDE.md (~296-304) to cite `test/helpers/sandbox-env.ts` by path; README.md (~431-445) to consolidate the duplicated env-var prose to reference the helper. Edit CLAUDE.md in place, never AGENTS.md.

### Investigation targets

**Required** (read before coding):
- test/commit-work.test.ts:64, test/find-task-commit.test.ts:52, test/session-state.test.ts:51 — Family A (verify still byte-identical), plus the `realpathSync(mkdtempSync())` wrapping and the pre-created-schema `openDb(dbPath).db.close()` beforeEach (NOT boilerplate — attribution reader hard-errors on absent DB; keep separate from the env helper)
- test/events-writer.test.ts:111, :1239 (fireViaLauncherWithEnv), :1432 (dead-letter override) — Family B + inlined merge sites + KEEPER_ZELLIJ_EVENTS_DIR
- test/integration.test.ts:153 (retryUntil), :189 (sandboxedBaseEnv)
- CLAUDE.md:296-304, README.md:431-445 — doc-touch sites

### Risks

- **Two-family reconciliation:** collapsing to one signature must not silently drop the id-clear (Family A) or the zellij var / non-clear behavior (Family B). Pin the API explicitly; a wrong default re-opens the isolation leak fn-657 closed.
- **realpathSync divergence:** Family A wraps tmpDir in realpathSync (macOS /var→/private/var) for path-equality vs project_dir; reducer/db/integration do not. The git-repo helper must take a stance (realpath always, or document caller responsibility) or path-equality assertions break.

### Test notes

`bun test test/commit-work.test.ts test/find-task-commit.test.ts test/session-state.test.ts test/events-writer.test.ts test/integration.test.ts` all green post-migration. Confirm no behavioral change (same env keys set, same id-clear semantics per family).

## Acceptance

- [ ] test/helpers/sandbox-env.ts exists; both families' behavior preserved; all five consumer files migrated
- [ ] backstop-telemetry/restore-worker/restore-agents/refold-progress left untouched
- [ ] test/helpers/git-repo.ts (initRepo, keeps commit.gpgsign false) and test/helpers/retry-until.ts exist and are exported
- [ ] CLAUDE.md and README.md cite the helper by path; AGENTS.md untouched (symlink)
- [ ] All migrated test files pass

## Done summary
Extracted test/helpers/{sandbox-env,git-repo,retry-until}.ts. sandboxEnv reconciles the two inline env families (id-clearing CLI-spawn + zellij hook-spawn) into one parameterized core with state paths applied last; migrated commit-work/find-task-commit/session-state/events-writer/integration. Cited the helper by path in CLAUDE.md + README.md (AGENTS.md symlink untouched).
## Evidence
