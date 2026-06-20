## Description

**Size:** M
**Files:** `plugins/plan/.planctl/` (delete, ~322 tracked files), `src/plan-worker.ts`, `src/git-worker.ts`, `test/plan-worker.test.ts`, `test/git-worker.test.ts`, `CLAUDE.md`, `README.md`, `src/commit-work/attribution.ts`

### Approach

De-vendor `plugins/plan/` in one cohesive change. **ORDER IS LOAD-BEARING:** delete the vendored board on disk FIRST, then remove the now-dead prune code, so the live daemon never folds the board into the `epics` projection. Steps:

1. `git rm -r plugins/plan/.planctl/` — the vendored dependency's OWN dev board (NOT keeper's root `.keeper/`). Scope the `rm` to `.planctl/` EXACTLY — never `plugins/plan/` or `plugins/plan/src/` (that would delete the live CLI `cli/plan.ts:22` imports).
2. Delete `isVendoredPlanPath` (`src/plan-worker.ts:455-467`) and its three call-site guards (`:1198` onDelete, `:1383` onChange, `:2247` scanRoot) — remove each guard branch, keep the surrounding logic.
3. Drop the two `IGNORE_GLOBS` entries (`src/plan-worker.ts:430-431`) and reword the array doc comment (`:423-429`) forward-facing.
4. In `src/git-worker.ts`, remove ONLY the `plugins/plan` reject branch from `isPlanctlChangedPath` (`:831-839`). KEEP the function, its `.keeper` classification, and all non-vendored behavior — it is the sole gate for `filterPlanctlChanges` (`:869`, called at `:1990`); deleting it whole breaks commit-forwarding. Reword its JSDoc (`:820-826`).
5. Trim vendored-prune test assertions: `test/plan-worker.test.ts` — delete the vendored-specific tests (`:214`, `:246`, `:270`, `:480`); in the `:295` test PRESERVE the root-`.keeper`-folds assertion and drop only the vendored half. `test/git-worker.test.ts` — in the `:1797` test delete the vendored assertions (`:1827`, `:1831`, `:1835`) and KEEP the non-vendored ones (`:1799-1820`, `:1839`).
6. Forward-facing docs: keeper-root `CLAUDE.md` — lines 15-18 drop "vendored via `git subtree --prefix=plugins/plan`"; lines 25-31 delete the entire subtree-discipline bullet (incl. the `isVendoredPlanPath` prune note). `README.md:380` — drop "vendored as a `git subtree`", state it is a native plugin loaded by agentwrap. `src/commit-work/attribution.ts:41` — drop the stale "vendored plugin board" justification from the comment (the `.planctl/` entry in `PLANCTL_EXCLUDE_PREFIXES` STAYS as a live migration fallback for other repos). Edit `CLAUDE.md` in place — `AGENTS.md` is a symlink, never rm+recreate. Forward-facing only: state the present, never "used to be a subtree".

**OUT OF SCOPE (do not touch):** symbol renames — `isPlanctlChangedPath` and `planctlMain` keep their current names (deferred to the later en-masse sweep); `cli/plan.ts:22` import (stays); any schema / `events.data` / re-fold path; `docs/planctl-strip.md` (owned by the planning session).

### Investigation targets

**Required** (read before coding):
- `src/plan-worker.ts:414-467` — `IGNORE_GLOBS` array + `isVendoredPlanPath` def
- `src/plan-worker.ts:1194-1200`, `:1378-1384`, `:2244-2249` — the three call sites + comments
- `src/git-worker.ts:820-869` — `isPlanctlChangedPath` def + the reject branch + the `filterPlanctlChanges` caller (confirm what must stay)
- `test/plan-worker.test.ts:208-300`, `:480` — vendored-prune tests (preserve root-fold coverage)
- `test/git-worker.test.ts:1797-1839` — `isPlanctlChangedPath` test (keep non-vendored assertions)

**Optional** (reference as needed):
- `CLAUDE.md:14-31` — repo-facts + subtree block + the AGENTS.md-symlink rule
- `README.md:380` — subtree prose
- `src/commit-work/attribution.ts:41-44` — stale "vendored plugin board" comment

### Risks

- Scoping `isPlanctlChangedPath` removal too widely (deleting the whole function) silently breaks commit-forwarding via `filterPlanctlChanges` — remove ONLY the `plugins/plan` branch.
- Removing the prune before the board is gone on disk would let the live watcher/boot-scan fold the vendored board into `epics` — delete the board first.
- `git rm` must target `plugins/plan/.planctl/` exactly — a stray `plugins/plan/` would delete the live CLI source.

### Test notes

- `bun run test:full` is MANDATORY (plan-worker + git-worker process paths); fast `bun test` does not cover these.
- After trimming, confirm the root-`.keeper`-folds coverage and the non-vendored `isPlanctlChangedPath` coverage still pass.
- Run the plan plugin's own suite too (`bun test` in `plugins/plan/`) — the deleted board lives under that dir.

## Acceptance

- [ ] `plugins/plan/.planctl/` deleted; `plugins/plan/src/` (incl. `cli.ts`) and the `cli/plan.ts:22` import untouched
- [ ] `isVendoredPlanPath` + its 3 call-site guards + the 2 `IGNORE_GLOBS` entries removed
- [ ] `isPlanctlChangedPath` retains `.keeper` classification; only the `plugins/plan` reject branch removed; `filterPlanctlChanges` still gates correctly
- [ ] Vendored-prune test assertions trimmed; root-fold + non-vendored coverage retained and green
- [ ] `CLAUDE.md` + `README.md` + `attribution.ts:41` comment rewritten forward-facing (no "was a subtree" narration); `AGENTS.md` symlink untouched
- [ ] `bun run test:full` passes; plan plugin `bun test` passes

## Done summary

## Evidence
