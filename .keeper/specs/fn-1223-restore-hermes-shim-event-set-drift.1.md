## Description

Restores the drift guarantee traded away by finding F1. Evidence path: the
contract list `HERMES_SHIM_EVENTS` is a hard-coded literal in
`src/hermes-shim-contract.ts` (~line 17), while the hook's translation table
`HERMES_EVENT_MAP` lives in `plugins/keeper/plugin/hooks/hermes-events-shim.ts`
(~line 95) and is currently not exported. They are reconciled only by the
DRIFT GUARD comments (contract ~line 12, hook ~lines 116-117). No test asserts
their equality, so adding an event to one list without the other silently
registers a stale `hooks:` block and hermes never invokes the shim for the
new event.

Add a fast-tier (`bun test`, pure in-process) test that imports the contract
list and the hook's map and asserts `Object.keys(HERMES_EVENT_MAP).sort()`
deep-equals `[...HERMES_SHIM_EVENTS].sort()`. This requires exporting
`HERMES_EVENT_MAP` from the hook (an additive export; keep hook fail-open and
dep-discipline intact — no `bun:sqlite`/`src/db.ts` reachable from the hook).

Files:
- `plugins/keeper/plugin/hooks/hermes-events-shim.ts` (export `HERMES_EVENT_MAP`)
- `src/hermes-shim-contract.ts` (source of `HERMES_SHIM_EVENTS`)
- a new fast-tier test under `test/`

## Acceptance

- [ ] Test deep-equals the map key set against the contract list, sorted
- [ ] Test is red when the two lists diverge, green in the current matching state
- [ ] `bun test` passes; hook keeps its `node:*` + dep-free-helper import discipline

## Done summary

## Evidence
