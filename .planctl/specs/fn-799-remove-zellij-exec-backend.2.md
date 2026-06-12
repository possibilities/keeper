## Description

**Size:** S
**Files:** plugin/hooks/events-writer.ts, test/helpers/sandbox-env.ts, test/events-writer.test.ts

### Approach

Delete the zellij sentinel block from `backendExecCoordsFromEnv` (`plugin/hooks/events-writer.ts:258-271`) and the zellij half of the surrounding doc comments (`:237`, `:714`). The tmux block (`:272-286`) and the neither-set → all-NULL tail (`:287-288`) stay. New precedence is implicit tmux-first: a Claude pane nested in zellij-under-tmux now stamps tmux coords — pin that with a test rather than leaving it implied. The hook's invariants are hard: always exit 0, no third-party deps, no `bun:sqlite`/`db.ts` imports — the edit removes code, it must not widen the import set. `execBackendEnvMeta` (imported at `:45` from `src/exec-backend.ts`) keeps working whether task .1 has landed or not; this task only deletes the local zellij branch.

In `test/helpers/sandbox-env.ts`, remove the `includeZellij` option and the `KEEPER_ZELLIJ_EVENTS_DIR` path it adds (`:89-90`) — the var has ZERO production readers (fn-684's bridge is already gone; this is pure test vestige). Update the helper's doc comment (the "SEVENTH var" framing at `:19`, `:41`) and the four `includeZellij: true` call sites, all in `test/events-writer.test.ts` (`:144`, `:1196`, `:1207`, `:1216`). Keep `sandboxEnv` itself and its five mandatory state paths untouched — shared infrastructure, not zellij-specific.

### Investigation targets

**Required** (read before coding):
- plugin/hooks/events-writer.ts:237-289 — `backendExecCoordsFromEnv` and its doc comment; the deletion site
- test/helpers/sandbox-env.ts:19-41, 89-90 — `includeZellij` flag and doc comment
- test/events-writer.test.ts:119-150, 1196-1216 — the `KEEPER_ZELLIJ_EVENTS_DIR` test plumbing and `includeZellij: true` call sites

**Optional** (reference as needed):
- src/exec-backend.ts:236-257 — `execBackendEnvMeta`, the hook's one cross-module import for backend env metadata

### Risks

- Hook fail-open invariant: any edit slip that lets the hook exit non-zero can fail-closed a live session. The change is pure deletion inside one function — keep it that way.
- Precedence flip is a real behavior change for zellij-nested-under-tmux panes (zellij used to win). Human is off zellij entirely, so no live rows retag — but the test must pin the new winner so the contract is explicit.

### Test notes

`test/events-writer.test.ts` is SLOW tier — `bun run test:full` required, default `bun test` won't run it. Drop zellij-derivation cases (ZELLIJ sentinel → zellij coords), add the inverse: both `ZELLIJ` and `TMUX` env set → tmux coords; only `ZELLIJ` set → all three coords NULL. Audit that no test still expects `KEEPER_ZELLIJ_EVENTS_DIR` in the spawned hook's env.

## Acceptance

- [ ] `backendExecCoordsFromEnv` reads only `TMUX`/`TMUX_PANE`/`KEEPER_TMUX_SESSION`; zellij sentinel block gone; test pins ZELLIJ-env-only → NULL coords and both-set → tmux coords
- [ ] `includeZellij` and `KEEPER_ZELLIJ_EVENTS_DIR` gone from `test/helpers/sandbox-env.ts` and all call sites; the five mandatory sandbox paths unchanged
- [ ] Hook import set unwidened (node:fs/os/path + dead-letter + derivers/exec-backend helpers only); hook still always exits 0
- [ ] `bun run test:full` green

## Done summary
Removed the includeZellij flag and KEEPER_ZELLIJ_EVENTS_DIR (zero production readers) from sandboxEnv and its events-writer call sites; events-writer.ts source and the ZELLIJ-only/both-set pin tests were already landed, five mandatory sandbox state paths untouched. Full suite green.
## Evidence
