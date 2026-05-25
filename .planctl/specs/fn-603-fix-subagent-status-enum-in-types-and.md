## Overview

The `SubagentInvocation.status` field is declared as `"running" | "ok" | "error"` in
`src/types.ts` and in two README comment lines, but the actual reducer and collection
module use `"running" | "ok" | "failed" | "unknown"`. Widening the public union and
correcting the docs eliminates a silent type-narrowing trap for wire consumers and
ensures a future failure-path write cannot slip past the reducer's terminal-status guard.

## Acceptance

- [ ] `SubagentInvocation.status` in `src/types.ts` is `"running" | "ok" | "failed" | "unknown"`
- [ ] `src/types.ts` doc comment (line ~292) updated from `running → ok / running → error` to `running → ok / running → failed / running → unknown`
- [ ] `README.md` lines ~70 and ~432 updated from `running | ok | error` to `running | ok | failed | unknown`
- [ ] `src/db.ts` migration doc comment updated to match
- [ ] No arm writes the value `"error"` (verify grep)

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | Verified at src/types.ts:303, src/subagent-invocations.ts:91, src/reducer.ts:818+890, README.md:70+432 — public type diverges from runtime values used by reducer and collection descriptor; TS consumers silently miss two variants |
| F2     | culled | —    | Intentional deferred design; collection pk semantics documented at callsite |
| F3     | culled | —    | Defense-in-depth truncation, no current consumer does strict UTF-16 validation |
| F4     | culled | —    | Explicitly accepted by auditor; deriver is cheap and intentionally ungated |
| F5     | culled | —    | Theoretical; all typed fields allow null, no current path produces undefined |
| F6     | culled | —    | Contingent on F1 landing; no arm writes failed/unknown yet so branch is unreachable |
| F7     | culled | —    | Nice-to-have; migration follows established pattern with unit-test shape coverage |

## Out of scope

- Adding failure-path arms that write `"failed"` or `"unknown"` — that is a separate feature
- Adding the terminal-status reducer test (F6) — deferred until a failure-path writer exists
- Adding the migration rewind integration test (F7) — deferred to a later cycle
