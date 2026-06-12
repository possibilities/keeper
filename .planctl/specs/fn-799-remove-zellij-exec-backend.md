## Overview

keeper's autopilot dispatches workers through a pluggable exec backend. The tmux backend (fn-789) has full `ExecBackend` parity and is the one in production use; the zellij backend is dead weight. This epic deletes the zellij backend factory and arg builders, the hook's ZELLIJ* env scraping, the `zellij` config value, restore-file zellij routing, script support, tests, and docs — tmux becomes the sole and default backend. Producer-only change: historical events with `backend_type='zellij'` keep folding byte-identically (the fold is backend-agnostic and copies event strings verbatim).

## Quick commands

- `bun run test:full` — mandatory gate (hook/db/worker/restore paths all touched)
- `grep -ri zellij --exclude-dir=.planctl --exclude-dir=node_modules --exclude-dir=.git . | wc -l` → `0` when the epic is done
- `bun scripts/unstick-autopilot.ts` — liveness-probes the tmux managed session, no zellij subprocess

## Acceptance

- [ ] Zero zellij mentions in the repo outside `.planctl/` (code, tests, docs, comments, help text)
- [ ] `DEFAULT_EXEC_BACKEND === "tmux"` in BOTH `src/exec-backend.ts` and the hand-synced mirror in `src/db.ts`; `VALID_EXEC_BACKENDS` is `{"tmux"}`
- [ ] Hook scrapes only `TMUX`/`TMUX_PANE`/`KEEPER_TMUX_SESSION`; stays dep-free and exit-0
- [ ] No reducer fold-logic change (`src/reducer.ts` edit is comment-only); no `SCHEMA_VERSION` or `RESTORE_SCHEMA_VERSION` bump
- [ ] `bun run test:full` green

## Early proof point

Task that proves the approach: `.1` (core teardown). If it fails: the zellij factory deletion is pure removal behind the `resolveExecBackend` seam — revert is a clean `git revert` with no data migration to unwind.

## References

- `docs/exec-backend.md` — module reference being rewritten in `.3`
- `fn-793` (overlap) — pins tmux retry behavior in `src/exec-backend.ts` and corrects `docs/exec-backend.md`; both files are gutted/rewritten here, so fn-793 lands first to avoid concurrent edits
- `fn-794` (overlap) — adds history read verbs touching `src/types.ts`, which this epic edits for comment cleanup
- Restore side-file has its OWN `RESTORE_SCHEMA_VERSION` (3, independent of DB schema); per-bucket `backend` tag arrived at v3 — the default flip is a value change, not a format change, so no bump
- `scripts/unstick-autopilot.ts:54` imports `DEFAULT_ZELLIJ_SESSION`, a symbol that NO LONGER EXISTS in `src/exec-backend.ts` — it resolves to `undefined`, so the script's `--session-name` default is already silently broken; `.1` repairs it against tmux

## Docs gaps

- **docs/exec-backend.md**: full rewrite, not an append — two-backend framing (tag-dispatch paragraph, zellij fallthrough, zellij launch/focusPane/session-ensure blocks, eight `buildZellij*` helper-table rows) all goes; keep the table-of-helpers + fenced-ts style
- **README.md**: four clusters — hook env-scraping (~58-62), `exec_backend` config key (~320-349), architecture hook-scraping (~1742-1748), autopilot/ExecBackend block (~2252-2349)
- **CLAUDE.md**: two line edits — hook-rules "Scraping is scoped" bullet drops `ZELLIJ*`; test-isolation section drops the `includeZellij`/`KEEPER_ZELLIJ_EVENTS_DIR` sentence (AGENTS.md is a symlink — edit in place)

## Best practices

- **Audit-then-delete test discipline:** for every zellij-specific test, check whether a tmux test covers the equivalent contract surface; write the tmux equivalent BEFORE deleting if not [practice-scout]
- **Producer-only event change:** stop producing zellij coords at the hook; never touch how stored rows fold — re-fold determinism is the contract with the past [event-versioning literature + repo invariant]
- **Keep shared test infrastructure:** delete zellij-specific cases, never the shared helpers (`sandboxEnv`, `retryUntil`) they ride on [practice-scout]
