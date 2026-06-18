## Description

**Size:** M
**Files:** plugins/plan/** (subtree), plugins/keeper/** (relocated), plugins/keeper/plugin/hooks/events-writer.ts (re-depth), keeper CLAUDE.md, keeper README.md, planctl CLAUDE.md/README (folded docs)

### Approach

Two coordinated moves landing together. (1) `git subtree add --prefix=plugins/plan <planctl-remote> main` WITHOUT `--squash` — preserves planctl's 408-commit history and the `git-subtree-split:` trailer so the unit stays extractable. (2) Relocate keeper's OWN plugin surface (`.claude-plugin/`, `hooks/`, `plugin/`, `skills/`) from the repo root into `plugins/keeper/`, preserving the `plugin/hooks/` substructure so `${CLAUDE_PLUGIN_ROOT}/plugin/hooks/events-writer.ts` still resolves. keeper's daemon/CLI/`src/` STAY at the repo root. Re-depth the events-writer's `../../src/{dead-letter,derivers,exec-backend}` imports to reach root `src/` from the new depth; keep `resolveEventsLogDir` byte-identical to `src/db.ts`. This task does NOT touch claudewrap config (that is `.3`) — so the launcher still points at `~/code/keeper` until `.3`; land them as a coordinated cutover.

### Detailed phases

1. Subtree-add planctl to `plugins/plan/` (no `--squash`); confirm history + trailer present (`git log plugins/plan | grep git-subtree-split`).
2. `git mv` the keeper plugin surface into `plugins/keeper/` (single manifest preserved — never two).
3. Re-depth events-writer imports; `bun run typecheck` proves the paths resolve; diff `resolveEventsLogDir` body against `src/db.ts` to prove byte-sync.
4. Fresh-session smoke: the events-writer loads and exits 0 (a load-time import crash fail-closes the session BEFORE the exit-0 guard — highest blast radius).
5. Confirm keeper's plan-worker folds only the root `.planctl/`, not the subtree's `plugins/plan/.planctl/` (nested-root pruning).
6. Fold the docs whose truth this task changes: keeper CLAUDE.md:13-16, README:369-376/:1212, planctl README:18-27 / CLAUDE.md:14 (forward-facing only).

### Investigation targets

**Required**:
- plugin/hooks/events-writer.ts:32-45 — the `../../src/{dead-letter,derivers,exec-backend}` imports to re-depth
- plugin/hooks/events-writer.ts:401-412 ↔ src/db.ts:333-340 — the byte-sync `resolveEventsLogDir` pair (must stay identical)
- hooks/hooks.json — 10× `${CLAUDE_PLUGIN_ROOT}/plugin/hooks/events-writer.ts` (plugin-relative; stable IF the sub-path is preserved)
- .claude-plugin/plugin.json — keeper manifest to relocate (exactly one, never duplicate)
- src/plan-worker.ts — root-anchored `.planctl` discovery + nested-root pruning (confirm `plugins/plan/.planctl` is not folded as a second project)

### Risks

- A wrong import depth crashes the hook at load → fail-closes every session before the exit-0 guard. Typecheck + fresh-session smoke are mandatory gates.
- `--squash`, a later rebase of the merge commit, or a GitHub squash-merge silently breaks `git subtree split`/`push` extractability forever (one-way door).
- Two `.planctl/` trees post-subtree (`plugins/plan/.planctl/` + root) — plan-worker must fold only the root.
- Two `bun.lock` (subtree + root) — confirm the keeper toolchain resolves the intended one.

### Test notes

Run BOTH suites + the arthack cli-boundary lint to prove no new cross-imports. `bun run test:full` in keeper (covers the relocated hook paths). Verify a fresh session loads the keeper plugin from `plugins/keeper/` and the hook writes an `events` row.

## Acceptance

- [ ] `plugins/plan/` carries planctl's full history (no `--squash`); `git subtree split --prefix=plugins/plan` reconstructs a pushable branch
- [ ] keeper plugin lives at `plugins/keeper/` with exactly ONE manifest + ONE hooks.json; root has no leftover `.claude-plugin/`/`hooks/`
- [ ] events-writer re-depth resolves (typecheck green); loads + exits 0 in a fresh session and appends an `events` row
- [ ] `resolveEventsLogDir` byte-identical to `src/db.ts`
- [ ] plan-worker folds only the root `.planctl/`, not `plugins/plan/.planctl/`
- [ ] `bun run test:full` + arthack boundary lint green; keeper daemon/CLI/src unmoved at root
- [ ] keeper CLAUDE.md / README + planctl CLAUDE.md / README updated forward-facing for the new layout

## Done summary
Folded planctl into keeper as a peer plugin: git subtree at plugins/plan/ (full 409-commit history, split-extractable) and relocated keeper's own plugin surface to plugins/keeper/ with re-depthed events-writer imports. Pruned the vendored plugins/plan/.planctl subtree from the plan-worker fold so planctl-dev epics never pollute keeper's projection, and scoped keeper's test/lint to exclude the subtree. test:full green, typecheck clean, hook loads+exits 0 from the new path.
## Evidence
