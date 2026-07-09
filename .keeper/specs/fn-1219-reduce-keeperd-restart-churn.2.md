## Description

**Size:** S
**Files:** src/proc-starttime.ts, src/hermes-shim-contract.ts, plugins/keeper/plugin/hooks/events-writer.ts, plugins/keeper/plugin/hooks/hermes-events-shim.ts, src/bus-worker.ts, src/seed-sweep.ts, src/agent/launch-handle.ts, src/birth-record.ts, CLAUDE.md

### Approach

Daemon code must never import hook modules; shared pieces become sanctioned dep-free src helpers that the HOOKS import — the allowed direction per CLAUDE.md's hook rules (docs/adr/0029). Move `parseLinuxStarttime` and `splitArgsLstart` from the events-writer hook into a new dep-free `src/proc-starttime.ts` (node:*-only, no bun:sqlite, no other keeper module); the hook imports them back at its existing `../../../../src/<name>` resolution depth, and src/bus-worker.ts + src/seed-sweep.ts import from src. Move `HERMES_SHIM_EVENTS` / `HERMES_SHIM_VERSION` into a new dep-free `src/hermes-shim-contract.ts`; the hermes shim imports it, and src/agent/launch-handle.ts imports from src. Extend CLAUDE.md's sanctioned dep-free helper list (the closed set in the Hook rules section) with the two new modules — edit the list in place, no narrative, and keep `bun scripts/lint-claude-md.ts` green (size cap, no re-narration). src/birth-record.ts holds byte-identical hand-copies of the two starttime helpers under a "MUST stay byte-identical" drift guard: repoint those comments at the new src home, and collapse the copies onto the shared helper ONLY if the import provably drags nothing impure into birth-record's closure — the neighboring seed-sweep path pulls bun:sqlite, so keeping guarded copies is the safe default. The pi extension is untouched — it keeps its own isolated contract copy by design.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/plugin/hooks/events-writer.ts:32-49 (existing src-helper import pattern + resolution depth), :153, :180 (the two helper definitions)
- plugins/keeper/plugin/hooks/hermes-events-shim.ts:113, :121 (the two contract constants)
- src/bus-worker.ts:44-47, src/seed-sweep.ts:73-75, src/agent/launch-handle.ts:17-21 — daemon-side import sites to repoint
- CLAUDE.md Hook rules section — the sanctioned dep-free helper list to extend

**Optional** (reference as needed):
- src/birth-record.ts:305-335 — the byte-identical hand-copies and their drift-guard comments
- scripts/lint-claude-md.ts — the gate the CLAUDE.md edit must keep green

### Risks

- A new src helper accidentally importing anything impure breaks the hooks' fail-open contract (hooks must stay node:*-only + dep-free helpers).
- The hook-relative `../../../../src` path depth is easy to get wrong; the hook degrades silently, so verify the import resolves by running the hook's own test coverage.

### Test notes

`bun test` green; `bun scripts/lint-claude-md.ts` green; repo-wide search proves zero imports of plugins/keeper/plugin/hooks/* from under src/.

## Acceptance

- [ ] No module under src/ imports from the keeper hook directory (repo-wide search over src/ returns zero such edges)
- [ ] Both hooks import the relocated helpers from src and their transitive closures remain free of bun:sqlite and non-sanctioned keeper modules
- [ ] CLAUDE.md's sanctioned dep-free helper list names the two new src modules and the CLAUDE.md lint script passes
- [ ] Full fast suite is green

## Done summary

## Evidence
