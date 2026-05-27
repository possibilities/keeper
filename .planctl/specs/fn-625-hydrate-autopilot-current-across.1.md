## Description

**Size:** S
**Files:** scripts/autopilot.ts, test/autopilot.test.ts

### Approach

Three coupled edits in `scripts/autopilot.ts`, then mirrored doc + test updates.

1. **`hydrateDispatchLog` (scripts/autopilot.ts:746-785)** — extend the return type with `restoredEntries: DispatchEntry[]`. After the existing pass that populates the three Sets, walk the parsed rows a second time and, for every `kind:"launch"` row where `fulfilledKeys.has(key) && !completedKeys.has(key) && row.dry !== true`, parse it back into a `DispatchEntry` (every needed field already lives on the launch row: `ts, kind, rowId, dir, dirFull, verb, id, command, pid`). Keep latest-per-key (later `ts` wins) so any historical re-dispatches collapse cleanly. Sort the final array by `ts` ascending so the oldest-first ordering of the rendered section is preserved.

2. **`main()` (scripts/autopilot.ts:886-888)** — destructure `restoredEntries` and seed `const dispatchLog: DispatchEntry[] = restoredEntries;`. No other call-site change — the partition at scripts/autopilot.ts:914-920 already keys off `completedKeys` / `fulfilledKeys` so restored entries automatically land under `--- current ---`.

3. **`detectJobTransitions` (scripts/autopilot.ts:1546-1607)** — implement the disappearance trigger the docstring at scripts/autopilot.ts:695-711 already describes but the code does not. Replace `if (job === undefined) { continue; }` with: if `fulfilledKeys.has(key) && job === undefined`, add `key` to `completedKeys` and append the same `kind:"completed"` JSONL line (verb / id / ts / pid) the terminal-state branch writes; then `continue`. The plain `!fulfilledKeys.has(key) && job === undefined` case still skips — a never-fulfilled launch is not the disappearance rule's concern.

4. **Header docstring (scripts/autopilot.ts:38-61)** + **`HELP` constant (scripts/autopilot.ts:133-216)** — flip the "scoped to THIS RUN" framing for `current` only. Document the hydration filter (`fulfilled && !completed && !dry`, latest-per-key, sorted by `ts` ascending) and the disappearance rule. Update the mid-flight-crash paragraph so it notes `current` now survives a mid-flight crash (queued does not).

5. **Tests (`test/autopilot.test.ts`, flat `bun:test` style, no `describe`)** — add cases per the matrix below. `hydrateDispatchLog` is already exported; the disappearance rule's effect on `detectJobTransitions` can be exercised via the exported helpers and the `dispatch.log` write side-effect or by injecting a snapshot through whichever seam the existing tests use.

### Investigation targets

**Required** (read before coding):
- scripts/autopilot.ts:746-785 — `hydrateDispatchLog`; return type lives here, second walk attaches here
- scripts/autopilot.ts:886-888 — `dispatchLog` seed in `main()`
- scripts/autopilot.ts:914-920 — partition logic that consumes hydrated entries (no change needed; verifies the seam works)
- scripts/autopilot.ts:1546-1607 — `detectJobTransitions`; disappearance trigger replaces `if (job === undefined) { continue; }`
- scripts/autopilot.ts:695-711 — docstring already describing the disappearance trigger this task implements
- scripts/autopilot.ts:38-61 — header docstring section that frames `current` as this-run-only today
- scripts/autopilot.ts:133-216 — `HELP` constant mirroring the docstring
- test/autopilot.test.ts — flat `bun:test` style; `hydrateDispatchLog` currently untested (see `grep -n hydrateDispatchLog test/autopilot.test.ts` → no matches)
- src/readiness-client.ts:840-841 — all-three-strict gate the disappearance rule relies on for full-page completeness (no change; context only)

## Acceptance

- [ ] `hydrateDispatchLog` returns `restoredEntries: DispatchEntry[]` populated from `kind:"launch"` rows where `fulfilledKeys.has(key) && !completedKeys.has(key) && row.dry !== true`, latest-per-key, sorted by `ts` ascending
- [ ] `main()` seeds `dispatchLog` from `restoredEntries` so a prior-run still-running dispatch renders under `--- current ---` on startup
- [ ] `detectJobTransitions` migrates a hydrated entry to `completedKeys` (AND writes the `kind:"completed"` JSONL line) when `fulfilledKeys.has(key) && findSessionJob(...) === undefined`; the plain never-fulfilled + undefined case still skips
- [ ] Header docstring (scripts/autopilot.ts:38-61) and `HELP` constant (scripts/autopilot.ts:133-216) describe the hydration filter, the disappearance rule, and the mid-flight-crash carve-out (current survives, queued does not)
- [ ] `bun test test/autopilot.test.ts` passes; new cases cover at minimum: launch+fulfilled,no-completed → restored; launch+fulfilled+completed → NOT restored; launch only → NOT restored; dry+fulfilled → NOT restored; two launches same `(verb,id)` different `ts` → latest-wins; multiple keys → sorted by `ts` ascending; disappearance rule fires for `fulfilled && job === undefined` and writes the `kind:"completed"` line

## Done summary

## Evidence
