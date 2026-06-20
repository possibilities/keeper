## Overview

`keeper board` today renders one combined frame: epics on top, a `~~~`
divider, then the bottom jobs list. This epic splits that into two
sibling TUIs following keeper's CLI/TUI conventions — `keeper board`
becomes epics-only, and a new `keeper jobs` carries the bottom jobs
list (the ambient/plan-bound two-partition list with nested sub-agent
lines). The dead-letter display (`[dead-letter:N]` banner pill + the
`r` replay-dead-letter key) MOVES to `keeper jobs` — removed from
board, not duplicated. Shared render primitives are extracted to a new
`src/board-render.ts` so both mains import them (convention: shared
infra in `src/`, view rendering in `cli/<sub>.ts`). Pure client-side
change — no schema bump, no keeper-py touch, server/projection
untouched.

## Quick commands

- `bun test test/board.test.ts test/jobs.test.ts test/keeper-cli.test.ts`
- `keeper board` — epics-only frame, no bottom jobs list, no dead-letter banner
- `keeper jobs` — ambient/plan-bound jobs list + `[dead-letter:N]` banner; `r` replays one dead-letter, `c` copies frame

## Acceptance

- [ ] `keeper board` renders epics only (no `~~~` jobs section, no dead-letter banner, no `r` key)
- [ ] `keeper jobs` renders the jobs list (ambient/plan-bound partitions + nested sub-agent lines) with the `[dead-letter:N]` banner and `c`/`r` keys
- [ ] Shared render primitives live in `src/board-render.ts`; both `cli/board.ts` and `cli/jobs.ts` import them; no `src/ → cli/` import and no circular import
- [ ] `test/board.test.ts` imports still resolve (via board re-export shims) and pass; new `test/jobs.test.ts` covers job-row shape + partitions + dead-letter pill; `test/keeper-cli.test.ts` covers `jobs` routing
- [ ] README + docstrings + HELP blocks describe the split and the dead-letter relocation

## Early proof point

Task that proves the approach: `.1` (extract to `src/board-render.ts`
with board re-export shims, suite stays green). If it fails: the
extraction surface is wrong — narrow the moved set or keep a helper in
board until the import graph is acyclic, before building jobs.ts.

## References

- Builds on the fn-646 OpenTUI port (created `cli/board.ts`, `cli/keeper.ts`, the `cli/<sub>.ts` dispatcher pattern)
- `src/readiness-client.ts` `subscribeReadiness` — the five-collection helper both views consume
- Potential test-helper coordination with fn-657 (centralizing hook-spawn env across test files) — advisory, not a hard edge

## Docs gaps

- **README.md**: line ~165 inline subcommand list; lines ~395-408 "clients ship under the unified keeper CLI" + drop the "(combined epics + jobs view)" parenthetical; the Example-clients board bullet (~427-537) splits into a board entry + a jobs entry with the dead-letter/`r` moved to jobs; add a `keeper jobs` example block near line ~536
- **CLAUDE.md / AGENTS.md**: design-stance client list (`keeper board`, …) gains `keeper jobs` — one-line update only, no new architecture prose
- **cli/board.ts**: module JSDoc + HELP — rewrite to the epics-only frame, drop the jobs body / second `~~~` / dead-letter / `r` key
- **cli/keeper.ts**: USAGE board blurb "Combined epics + jobs board" → "Epics board"; add `jobs` line

## Best practices

- **Copy → prove parity → relocate.** Extract the jobs render path and confirm byte-identical output against today's combined jobs section before modifying anything; doing extract + relocate in one step hides regressions.
- **No `src/ → cli/` imports, no barrel re-export.** The shared module imports nothing from `cli/`; board's shims are concrete named re-exports. A circular import in Bun returns `undefined` silently, not an error.
- **Single writer for the `r` key.** The replay handler lives in exactly one file (jobs) — board loses it entirely; no "handle it in both just in case."
- **Re-stamp the dead-letter banner before the body byte-compare short-circuit** in jobs.ts (count can change while the body is byte-stable) — preserve board.ts's current ordering.
