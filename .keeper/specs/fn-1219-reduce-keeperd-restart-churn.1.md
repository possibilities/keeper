## Description

**Size:** S
**Files:** src/duration.ts, src/autopilot-projection.ts, cli/duration.ts, cli/autopilot.ts, cli/handoff.ts, src/daemon.ts, src/readiness-client.ts, src/pair/panel.ts, src/agent/run-capture.ts, src/agent/pair-subcommands.ts

### Approach

Daemon code must never value-import from cli/ — cli may import src, never the reverse (docs/adr/0029 layering; precedent docs/adr/0008). Move `parseDuration` into a new dep-free leaf `src/duration.ts` following the src/slug.ts header idiom (explicit "DEP-FREE leaf" JSDoc); `cli/duration.ts` becomes a re-export so cli-side importers keep resolving. Move exactly five projection helpers — `projectAutopilotPaused`, `projectMaxConcurrentJobs`, `projectMaxConcurrentPerRoot`, `projectWorktreeMode`, `projectWorktreeMultiRepo` — from cli/autopilot.ts into a new `src/autopilot-projection.ts`; the sibling projectors (`projectAutopilotMode`, `projectArmedEpics`, `projectWorktreeStatusRows`, `projectFailedRows`) stay CLI-side, so this is a split of a non-contiguous region, not a wholesale move; cli/autopilot.ts re-imports the five from src. Move `HANDOFF_DOC_MAX_BYTES` into a dep-free src home (a small src/handoff-contract.ts, or an existing dep-free leaf if one genuinely fits); cli/handoff.ts re-imports it. Update the src-side importers (daemon, readiness-client, pair/panel, agent/run-capture, agent/pair-subcommands) to the new src paths. The five movers were verified at plan time not to reference cli/autopilot's module-private helpers (`seg`, `asArray`, `statusGlyph`, `shortTaskId`) — re-verify before cutting, including module-private constants.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/autopilot.ts:401-509 — the five movers; interleaved stayer projectAutopilotMode:463; other stayers :316, :378, :510
- cli/duration.ts:1-12 — already self-described "pure and dependency-free… the shared seam"; body moves unchanged
- src/daemon.ts:25-26 and src/readiness-client.ts:70-74 — the daemon-side import sites to repoint
- src/slug.ts:1-11 — the dep-free leaf header idiom to copy

**Optional** (reference as needed):
- src/pair/panel.ts:54, src/agent/run-capture.ts:21, src/agent/pair-subcommands.ts:17 — remaining parseDuration importers
- docs/adr/0008-pure-data-cli-descriptor-modules.md — layering precedent

### Risks

- A hidden module-private constant or helper crossing the cli/autopilot.ts split surfaces only at typecheck — cut carefully rather than mechanically.
- The new src modules must stay leaf (no imports into heavy src modules) or they drag weight into every cli invocation that re-exports them.

### Test notes

`bun test` green; `bun run typecheck` green; a repo-wide search proves zero `../cli` value imports remain under src/.

## Acceptance

- [ ] No module under src/ value-imports from cli/ (repo-wide search over src/ returns zero such edges; type-only imports also absent)
- [ ] parseDuration, the five autopilot projection helpers, and HANDOFF_DOC_MAX_BYTES are exported from src/ modules, and their previous cli import paths still resolve for cli-side callers
- [ ] Full fast suite and typecheck are green

## Done summary
Inverted the cli->src import edges: moved parseDuration, the five autopilot-config projection helpers, and HANDOFF_DOC_MAX_BYTES into new dep-free src/ leaves, with cli/ re-exporting each for existing callers.
## Evidence
