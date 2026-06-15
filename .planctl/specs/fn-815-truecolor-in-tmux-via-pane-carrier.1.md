## Description

**Size:** M
**Files:** src/exec-backend.ts, plugin/hooks/events-writer.ts, test/events-writer.test.ts, test/exec-backend.test.ts, docs/exec-backend.md, README.md, CLAUDE.md

### Approach

Keeper-side half of the lockstep (lands first; inert until claudewrap sets the carrier). Add the carrier env-var NAME to the single source of truth, then teach the hook a fallback arm.

1. `src/exec-backend.ts` (~132-152): add `readonly paneIdCarrierEnvVar: string` to `ExecBackendEnvMeta` and `paneIdCarrierEnvVar: "KEEPER_TMUX_PANE"` to the tmux return of `execBackendEnvMeta()`. Define the literal only here. Add a cross-reference comment that it must match the same string in `~/code/claudewrap/src/main.ts` (no shared module across repos; comments are the agreed drift guard).
2. `plugin/hooks/events-writer.ts` `backendExecCoordsFromEnv` (~252-272): keep the native `env.TMUX` arm FIRST and byte-unchanged. Insert a fallback arm between it and the all-NULL return: when `env.TMUX` is absent/empty AND `env[meta.paneIdCarrierEnvVar]` is present, apply the SAME empty→NULL collapse the native arm uses (events-writer.ts:266-267) to the carrier value and to `meta.sessionIdEnvVar`; if the carrier collapses to NULL, fall through to all-NULL (never stamp `type=tmux` with a NULL pane). Otherwise return `{ type: meta.backendType, sessionId: <KEEPER_TMUX_SESSION or null>, paneId: <carrier> }` — coord-identical to the native arm. Keep it a pure synchronous `process.env` read (no fs/fork; hook cold-start budget).
3. `CLAUDE.md` (~line 46): add `KEEPER_TMUX_PANE` to the scraping-scope env list (reviewer invariant; same commit). `AGENTS.md` is a symlink — edit `CLAUDE.md` only.
4. Docs: `docs/exec-backend.md` (helpers row + "Color-capable env" paragraph + "Extending to a new backend") and `README.md` (two-step env-read sequence) per the epic Docs gaps.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:132-152 — `ExecBackendEnvMeta` + `execBackendEnvMeta`; the `KEEPER_TMUX_SESSION`/`TMUX_PANE` centralization precedent to mirror
- plugin/hooks/events-writer.ts:252-272 — `backendExecCoordsFromEnv`; native arm + the :266-267 empty→NULL collapse to mirror
- plugin/hooks/events-writer.ts:699 — sole caller `backendExecCoordsFromEnv(process.env)`; :45 imports `execBackendEnvMeta`
- test/events-writer.test.ts:990-1095 — existing coord unit block to extend (patterns: "TMUX sentinel without KEEPER_TMUX_SESSION", empty-sub-var collapse, "ZELLIJ ignored")
- src/renamer-worker.ts:114-125 — read-only: the DB filter (`type==="tmux"` + non-null `pane_id`) the fallback coords must satisfy

**Optional**:
- test/exec-backend.test.ts:88-106 — env-meta test block
- CLAUDE.md ~44-47 — scraping-scope rule format

### Risks

- Coord drift between native and fallback arms would silently stop window renaming — assert byte-equivalence in tests.
- Forgetting the same-commit `CLAUDE.md:46` scraping-scope update trips the reviewer invariant.

### Test notes

Extend the coord block in test/events-writer.test.ts (runs under `bun run test:full` — default `bun test` skips this file): (a) carrier present + `TMUX` absent → `{type:"tmux", paneId, sessionId}` from carrier/`KEEPER_TMUX_SESSION`; (b) native `TMUX` present (carrier ignored) → unchanged; (c) carrier empty/absent + `TMUX` absent → all-NULL, no tmux stamp; (d) both `TMUX` and carrier present → native wins, coord-identical to native-only. Pure-fn style (no DB needed for `backendExecCoordsFromEnv`).

## Acceptance

- [ ] `execBackendEnvMeta("tmux").paneIdCarrierEnvVar === "KEEPER_TMUX_PANE"`; literal defined only in src/exec-backend.ts with a cross-ref comment to claudewrap
- [ ] native arm byte-unchanged; fallback arm stamps coord-identical `{type:"tmux", paneId, sessionId}` from the carrier when `$TMUX` absent; empty/absent carrier → all-NULL (no `type=tmux`); both present → native wins
- [ ] `CLAUDE.md` scraping-scope rule includes `KEEPER_TMUX_PANE`
- [ ] `docs/exec-backend.md` + `README.md` env-read sequence updated to the two-step read
- [ ] `bun run test:full` (incl. the new coord cases), `bun lint`, `bun typecheck`, `bun run assert-comment-only` all green

## Done summary

## Evidence
