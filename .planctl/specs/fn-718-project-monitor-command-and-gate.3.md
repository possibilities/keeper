## Description

**Size:** M
**Files:** cli/await.ts, skills/await/SKILL.md, README.md, CLAUDE.md, test/await.test.ts

### Approach

Wire `monitorRunningState` into a new `keeper await monitor-running
<selector>` condition. The selector takes one token that is NEITHER a
planctl id NOR nothing — a genuinely new arg arity (today's parser has
only nullary conditions and one-planctl-id conditions).

1. Add a third arity bucket in `parseAwaitArgs` (cli/await.ts ~:189-198, :294-336): the new condition takes one selector token. Add a `ConditionSegment` variant carrying the selector + its match-kind (command vs kind). Suggested selector syntax (implementer's discretion): a `kind:<kind>` / `cmd:<command>` prefix form, or a bare token defaulting to command-match with a `--kind` flag — must express BOTH exact command-match and exact kind-match. Keep it from colliding with the `and` grammar.
2. Add the eval arm alongside git-clean/agents-idle (cli/await.ts ~:988-1013) calling `monitorRunningState(ownSessionId, selector, jobsRows)`; reuse the jobs-collection subscription path (:501-514, :1121-1125). Read `ownSessionId` from `CLAUDE_CODE_SESSION_ID` (:1288). No git root needed (`needsRoot` stays false for this condition).
3. **Refuse-upfront pre-check** (chosen first-paint semantics): at arm time, if the selector matches nothing in the caller's own session's monitors, refuse loudly ("no monitor matching X is running in this session") rather than firing `met` immediately — mirrors the skill's off-board planctl refusal and biases away from premature-unblock. Document the same-turn-arm caveat (arm the await in a turn AFTER a Stop has snapshotted the monitor).
4. Update docs: cli/await.ts `HELP` constant (:69-115 — new condition row + any new terminal reason in the exit-code table); skills/await/SKILL.md (frontmatter trigger phrasing :3-24 for "wait until my script/monitor finishes"; condition table :64-69; parse "when this fires" bullet :36-50; Monitor wiring :118-133; reason/exit table :186-194; example block :214-256); README.md await-conditions list (~788-813 — revise the four-condition sentence to five, add one example); CLAUDE.md await mention if present.

### Investigation targets

**Required** (read before coding):
- cli/await.ts:189-198 (PLANCTL/NULLARY condition sets), :294-336 (`parseAwaitArgs`), :464-471 (`GitJobSlotState`), :988-1013 (git-clean/agents-idle eval arms), :501-514 + :1121-1125 (jobs subscription), :69-115 (`HELP`), :1284-1288 (`needsRoot`, `ownSessionId`)
- skills/await/SKILL.md:3-24 (frontmatter), :36-50 (parse), :64-69 (condition table), :118-133 (Monitor wiring), :186-194 (reason/exit table), :214-256 (examples)
- src/await-conditions.ts (`monitorRunningState` from T2 — the predicate being wired)

**Optional** (reference as needed):
- test/await.test.ts:535-613 (arg-parse tests — nullary, stray-id rejection, and-grammar)
- README.md:788-813

### Risks

- The new arg arity is the fiddly part — it must not break the existing nullary/planctl parse paths or the `and`-combination grammar.
- Refuse-upfront vs same-turn-arm: document the caveat so a consumer arming the await in the same turn it launches the monitor isn't surprised by a refusal.

### Test notes

Arg-parse tests for the new selector arity (valid selector; missing selector → error; and-combined with git-clean/agents-idle). A refuse-upfront test (no matching monitor at arm → refuses, not instant-met). Reuse T2's `monitorRunningState` fixtures for the eval-arm behavior.

## Acceptance

- [ ] `keeper await monitor-running <selector>` parses (new arity), evaluates via `monitorRunningState`, and combines with the existing conditions under the `and` grammar
- [ ] No matching monitor at arm time → loud refusal (not instant met); the same-turn-arm caveat is documented
- [ ] `HELP`, SKILL.md (table/parse/wiring/exit/examples/frontmatter), README await-conditions list, and CLAUDE.md are updated; the README list reads as five conditions, not "four and also"
- [ ] Arg-parse + eval-arm tests green

## Done summary

## Evidence
