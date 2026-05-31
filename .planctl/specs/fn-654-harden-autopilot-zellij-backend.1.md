## Description

**Size:** M
**Files:** src/exec-backend.ts, src/db.ts, test/exec-backend.test.ts, README.md, CLAUDE.md

### Approach

Surgically remove the Ghostty/osascript backend so zellij is the only
`ExecBackend`. The delete targets are precise (scout-verified line refs
below) — only Ghostty symbols and the `name === "ghostty"` resolver branch
go; the zellij factory and the orphan-default-tab reap machinery
(`buildZellijCloseTabArgs`, `buildZellijListTabsArgs`,
`firstTabIdFromListTabs`, `pendingOrphanTabId`) are zellij-only and MUST
survive. Collapse `resolveExecBackend` to a thin always-zellij seam (keep
the function so cli/autopilot.ts + config don't need a structural rewrite,
but drop the `name` branch). Drop the `exec_backend` config key entirely
from `KeeperConfig` and `resolveConfig` — `resolveConfig` already silently
ignores unknown YAML keys, so a legacy `exec_backend: ghostty` in a live
config becomes inert (no special warn path; the design stance favors clean
removal over a vestigial one-value key). Update BOTH `DEFAULT_EXEC_BACKEND`
lockstep sites (src/db.ts AND src/exec-backend.ts) and narrow every
`"ghostty" | "zellij"` type annotation. Delete the Ghostty tests and the
CLAUDE.md Ghostty-OOM known-issue block. Keep `ExecBackend`/`LaunchOptions`
(still the right seam, one impl) but prune the "ignored by Ghostty" prose.
Do NOT weaken the zellij `isSurfaceLive` gate (8ef4371) — only the Ghostty
`isSurfaceLive` no-op impl is deleted.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:202-254 — `buildGhosttyLaunchArgs` / `buildGhosttyCloseArgs` (delete)
- src/exec-backend.ts:460 — `quoteForShell` (delete; Ghostty-only consumer)
- src/exec-backend.ts:473-569 — `createGhosttyBackend` incl yabai move :501-512 + `isSurfaceLive` no-op :565-567 (delete)
- src/exec-backend.ts:149-152 — `GhosttyBackendDeps` interface (delete)
- src/exec-backend.ts:811-833 — `resolveExecBackend`: drop the `name === "ghostty"` branch :815-817, keep the thin zellij-always seam
- src/exec-backend.ts:136 — `DEFAULT_EXEC_BACKEND` literal (lockstep site A)
- src/db.ts:117 — `DEFAULT_EXEC_BACKEND` literal (lockstep site B); :141 `KeeperConfig.execBackend`; :192 `let execBackend`; :225-228 `exec_backend` parse block (drop)
- src/exec-backend.ts:653-693 — orphan-reap machinery (KEEP — verify untouched)
- test/exec-backend.test.ts — Ghostty tests to delete: `buildGhosttyLaunchArgs`, `buildGhosttyCloseArgs`, 3 `createGhosttyBackend.*`, `createGhosttyBackend.isSurfaceLive`, `resolveExecBackend: 'ghostty'`. KEEP the `DEFAULT_EXEC_BACKEND === 'zellij'` test.
- CLAUDE.md ~506-535 — "Known issue: autopilot Ghostty surface-init OOM" block (delete whole block, no stub)

### Risks

- The lockstep `DEFAULT_EXEC_BACKEND` literal lives in two files with an explicit "MUST stay in lockstep" comment — narrowing the type in one and not the other breaks the build. Change both together.
- `resolveExecBackend`'s call site (cli/autopilot.ts:2175) passes `cfg.execBackend`; if the key is fully dropped from `KeeperConfig`, that arg disappears — reconcile the call site and the function signature in the same change.
- Deleting too eagerly: `quoteForShell` is Ghostty-only, but confirm nothing in the zellij path imports it before removing.

### Test notes

Delete the named Ghostty tests rather than skipping them. Add a `test/config.test.ts` case (or extend it) proving a config carrying `exec_backend: ghostty` resolves cleanly to a zellij backend (key ignored, no throw). `bunx tsc --noEmit` clean; `bun test test/exec-backend.test.ts test/config.test.ts` green.

## Acceptance

- [ ] `createGhosttyBackend`, `buildGhosttyLaunchArgs`, `buildGhosttyCloseArgs`, `quoteForShell`, `GhosttyBackendDeps`, the yabai move, and the Ghostty `isSurfaceLive` no-op are gone from src/exec-backend.ts
- [ ] `resolveExecBackend` no longer branches on `"ghostty"`; returns a zellij backend unconditionally
- [ ] `exec_backend` is removed from `KeeperConfig` + `resolveConfig`; a legacy `exec_backend: ghostty` config resolves to zellij with no throw (covered by a test)
- [ ] both `DEFAULT_EXEC_BACKEND` lockstep sites + all `"ghostty" | "zellij"` type annotations updated
- [ ] Ghostty tests deleted; `DEFAULT_EXEC_BACKEND === 'zellij'` test retained; CLAUDE.md Ghostty-OOM block deleted with no stub heading
- [ ] the orphan-default-tab reap machinery and the zellij `isSurfaceLive` gate are untouched
- [ ] `bunx tsc --noEmit` and `bun test test/exec-backend.test.ts test/config.test.ts test/autopilot.test.ts` all green

## Done summary

## Evidence
