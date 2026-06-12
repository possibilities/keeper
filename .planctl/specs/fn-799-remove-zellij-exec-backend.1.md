## Description

**Size:** M
**Files:** src/exec-backend.ts, src/db.ts, src/autopilot-worker.ts, cli/jobs.ts, src/restore-worker.ts, scripts/restore-agents.ts, scripts/unstick-autopilot.ts, test/exec-backend.test.ts, test/config.test.ts, test/db.test.ts, test/jobs.test.ts, test/restore-worker.test.ts, test/restore-agents.test.ts, test/autopilot-worker.test.ts, test/reducer-projections.test.ts

### Approach

Delete the zellij side of `src/exec-backend.ts`: `createZellijBackend`, the eight `buildZellij*` arg builders, `zellijSessionListed`, the session-ensure poll, and the zellij-only shared helpers `ANSI_CSI_RE` and `delay` (grep for surviving consumers first; `scripts/unstick-autopilot.ts` has its own local `stripAnsi` — leave unrelated code alone). Flip `DEFAULT_EXEC_BACKEND` to `"tmux"` at `src/exec-backend.ts:95` AND the hand-synced literal mirror at `src/db.ts:84` in the same change; `VALID_EXEC_BACKENDS` (`src/db.ts:88`) becomes `{"tmux"}` so an explicit `exec_backend: "zellij"` config takes the existing unknown-value warn-and-fall-back path (`src/db.ts:183-189`), now landing on tmux. Collapse `resolveExecBackend` (`src/exec-backend.ts:838-851`) to always construct the tmux backend — it must FALL THROUGH on unknown/NULL/legacy `'zellij'` tags, never throw, because per-row `backend_exec_type` values from historical jobs flow in via `cli/jobs.ts:90` and `src/restore-worker.ts:335`. Keep `resolveExecBackend` as the single seam (consumers: `src/autopilot-worker.ts:48`, `cli/jobs.ts:90`, `scripts/restore-agents.ts:59`) — do not inline `createTmuxBackend` at call sites. `execBackendEnvMeta` (`src/exec-backend.ts:236-257`) loses its zellij branch; the fallback returns the tmux env-var names, and it stays importable by the dep-free hook.

In `scripts/restore-agents.ts`: every bucket now coerces to tmux — delete the `KNOWN_EXEC_BACKENDS` set (`:151`) and the `skipped-backend` routing (`:401-430`, `:764-802`); an explicit `backend: "zellij"` bucket relaunches in tmux, consistent with the NULL-tag coercion at `src/restore-worker.ts:335` (which flips automatically via the `DEFAULT_EXEC_BACKEND` import). Fix the now-false comment at `scripts/restore-agents.ts:154` ("NULL coerced to the zellij default"). No `RESTORE_SCHEMA_VERSION` bump — value change, not format change.

Rework `scripts/unstick-autopilot.ts` against tmux: replace the phantom `DEFAULT_ZELLIJ_SESSION` import (`:54` — the symbol no longer exists in exec-backend.ts; it resolves to `undefined`, so the script's `--session-name` default is broken today) with `MANAGED_EXEC_SESSION`, and swap the `zellij list-sessions` spawn + EXITED-line parsing (`:233-260`) for a `tmux has-session -t <name>` probe. Update help text (`:73`) and warnings (`:321-342`) to tmux phrasing.

Sweep stale zellij comments in every file this task touches (`src/autopilot-worker.ts` ~10 incl. the backend select at `:1555`, `cli/jobs.ts:7,198,649-651,803`, `src/restore-worker.ts` incl. the two dangling `{@link parseZellijWatermarks}` refs at `:429,:473` — that function has no live callers and no definition; the refs are prose-only). Forward-facing prose only: surviving tmux comments must not say "mirrors zellij" or narrate the removal.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:79-145 — shared helpers; verify which the tmux factory still needs (`RUN_CAPTURE_TIMEOUT_MS`, `streamToText`, `defaultSpawn` stay; `ANSI_CSI_RE`, `delay` go)
- src/exec-backend.ts:566-851 — the tmux backend + `resolveExecBackend`; everything here survives, the collapse happens at 838-851
- src/db.ts:84-88, 141-230 — mirror literal, `VALID_EXEC_BACKENDS`, warn-and-fall-back path
- scripts/restore-agents.ts:151-160, 401-430, 764-802 — `KNOWN_EXEC_BACKENDS` + skipped-backend routing to delete
- scripts/unstick-autopilot.ts:54, 73, 233-260, 288-301 — phantom import, help text, zellij liveness probe, arg default

**Optional** (reference as needed):
- src/restore-worker.ts:165-178, 269, 335 — restore-file versioning facts; NULL coercion flips via import
- src/autopilot-worker.ts:1555 — backend select comment
- src/reducer.ts:2927 — do NOT touch fold logic; this file's zellij mention is task .3's comment sweep

### Risks

- The `db.ts:84` mirror is a hand-synced literal, not an import — flipping one without the other drifts silently. Both land in this task's single commit. Consider a cheap guard test asserting the two stay equal.
- If the `resolveExecBackend` collapse throws on unknown tags instead of falling through, every legacy zellij-tagged job row crashes focus routing — pin the fall-through with a test.
- `test/reducer-projections.test.ts` zellij literals are HISTORICAL EVENT DATA exercising fold copy-through — the fold is backend-agnostic and those tests may keep their literals where that's what they exercise. Do not "clean" them into changing fold behavior; re-fold determinism is sacred.

### Test notes

`test/exec-backend.test.ts` (127 mentions) is the dominant rework: delete the zellij describe-blocks, and for each deleted zellij case verify a tmux test covers the equivalent contract surface (launch, focusPane, ensureLaunched, session-ensure, timeout-kill, vanished-session re-mint) — write the tmux equivalent before deleting if not. Add: `resolveExecBackend('zellij')` → tmux instance (fall-through pinned); config `exec_backend: "zellij"` → warn + tmux (`test/config.test.ts` / `test/db.test.ts`); explicit-zellij restore bucket → relaunches in tmux (`test/restore-agents.test.ts`); drop any assertion on the old `skipped-backend{backend:"zellij"}` shape. Fast tier covers most of this file set, but `db.test.ts`/`autopilot-worker.test.ts` are slow-tier — run `bun run test:full` before landing.

## Acceptance

- [ ] No zellij identifier, subprocess spawn, or string literal survives in src/, cli/, or scripts/ (comments included in touched files)
- [ ] `DEFAULT_EXEC_BACKEND === "tmux"` in both `src/exec-backend.ts` and `src/db.ts`; `VALID_EXEC_BACKENDS` is `{"tmux"}`; explicit `"zellij"` config warns and falls back to tmux
- [ ] `resolveExecBackend` returns the tmux backend for `"tmux"`, `"zellij"`, `undefined`, and garbage tags — asserted by test
- [ ] Explicit `backend: "zellij"` restore bucket relaunches in tmux; `skipped-backend` routing is gone
- [ ] `bun scripts/unstick-autopilot.ts --help` shows a tmux session default; liveness probe uses `tmux has-session`
- [ ] `bun run test:full` green

## Done summary

## Evidence
