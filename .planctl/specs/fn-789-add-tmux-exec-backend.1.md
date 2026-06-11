## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/exec-backend.ts, src/db.ts, src/daemon.ts, ~/.config/keeper/config.yaml, test/exec-backend.test.ts, test/autopilot-worker.test.ts (or equivalent), test/db.test.ts

### Approach

Two coupled moves that clear the decks for the tmux backend. (1) DELETE both
window reaps: the completion reap (`reapCompletionSurfaces` autopilot-worker.ts:1828,
`isCompletionReapCandidate` :372, `reapFloorElapsed` :298, `MIN_REAP_INTERVAL_S` :110)
and the pause-ghost reap (`reapLaunchWindowSurfaces` :1782, `isReapCandidate` :340),
plus the whole `autocloseWindows` thread (db.ts:99,108,183-186; daemon.ts:2768;
autopilot-worker.ts:1314,1564). Remove `reapSurfaces` from the `ExecBackend`
interface (exec-backend.ts:83) and the zellij impl, and drop the now-dead zellij
plumbing: `buildZellijClosePaneArgs`, `buildZellijListPanesAllJsonArgs`,
`collectPanesFromListJson`, `closePaneIdForReap`, `dispatchKeyForPane`, and
`findPaneById` after verifying it has no consumer outside the reap path and tests.
Keeper never closes a window after this task. (2) Config seam: add `exec_backend`
parsing to `resolveConfig` (db.ts:130-230) — values `zellij`|`tmux`, default
`zellij`, unknown value logs a warn and falls back, per the every-key-independent
convention. DELETE `zellij_session` parsing (db.ts:166-169, mirror comment :83-84;
nothing sets it). Rename `DEFAULT_ZELLIJ_SESSION` to one shared managed-session
constant (e.g. `MANAGED_EXEC_SESSION = "autopilot"`) exported from exec-backend.ts
and used by ALL backends; reconcile the autopilot worker's `zellijSession`
workerData field (autopilot-worker.ts:1303, daemon.ts:2764) — the worker now uses
the constant, the field dies. Thread `exec_backend` through workerData in its
place (consumed by task 2's resolveExecBackend switch; until then the value is
parsed and passed but only `zellij` exists). Also remove the `autoclose_windows`
key + its comment block from the human's local `~/.config/keeper/config.yaml`
(outside the repo — edit it directly, it is this machine's file).

Rewrite forward-facing comments that narrate the deleted reaps or
"zellij is the only backend" where they sit adjacent to edited code; the full
docs sweep is task 4.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:51-84 — ExecBackend interface; reapSurfaces leaves it
- src/autopilot-worker.ts:1782-1860 — both reap blocks and their call sites
- src/db.ts:130-230 — resolveConfig per-key pattern for the exec_backend addition
- src/daemon.ts:2760-2775 — autopilot worker spawn block (workerData fields to reconcile)

**Optional** (reference as needed):
- test/exec-backend.test.ts:21 — imports isCompletionReapCandidate from autopilot-worker; those cases go
- .planctl/specs/fn-710-tear-out-inert-zellij-tab-subsystem.md — the prior deletion epic; same hygiene applies

### Risks

- `findPaneById` is flagged likely-dead [INFERRED] — verify with a repo-wide grep before deleting; if a live consumer exists, leave it and note in the Done summary.
- Deleting workerData fields requires touching the `satisfies` interface — typecheck catches misses; run `bun run typecheck` before tests.

### Test notes

Fast tier covers the config parsing (exec_backend default/valid/unknown-warn,
zellij_session gone) and the slimmed exec-backend module. `bun run test:full`
mandatory (autopilot-worker + daemon paths). Assert the reap helpers are gone by
compilation, not by grep-shaped tests.

## Acceptance

- [ ] Both reaps, all reap helpers, `reapSurfaces`, and the listed zellij close/list-panes builders are deleted; `findPaneById` verified-then-deleted or kept with a named consumer
- [ ] `autoclose_windows` and `zellij_session` are gone from code AND `~/.config/keeper/config.yaml` (key + comment block)
- [ ] `exec_backend` parses with default `zellij`, unknown-value warn+fallback; the shared `"autopilot"` constant is the only managed-session name source
- [ ] `bun run typecheck` and `bun run test:full` green

## Done summary

## Evidence
