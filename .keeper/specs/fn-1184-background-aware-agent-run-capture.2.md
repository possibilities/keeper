## Description

**Size:** S
**Files:** src/agent/launch-config.ts, src/agent/main.ts, test/agent-byte-pin.test.ts, plugins/plan/skills/panel/references/panel.md, plugins/keeper/skills/pair/SKILL.md

### Approach

Behavioral contract: every `keeper agent run` leg's composed prompt carries a
final-message contract directive — the final assistant message is the captured
deliverable and must be one complete, self-contained answer; the partner avoids
background agents and background tasks, and if any run it must not end its final
turn until they complete and their results are folded into that one message
(never an answer-then-followup delta, never a back-reference to an earlier
message). Add the directive as an exported string constant sibling to the
read-only directive (same plain-const + WHY-JSDoc style) and prepend it in the
caller-side prompt composition, always-on and uniform across harnesses (the
caller stays the sole prepender; the prose is harmless to codex/pi/hermes).
Block-order decision, frozen by tests once made: the read-only directive keeps
its leading position when present; the final-message directive slots after it
and before the System block — read-only, then final-message, then System, then
prompt. Update the byte-pin posture assertions to the new composition (six
pinned strings) as a deliberate test-surface update, re-deriving each expected
string from the intended composition rather than from test output. Panel legs
and pair single-shots inherit the directive through the shared compose site;
verify no leg-launch path bypasses it. Skill prose (forward-facing, present
tense, prune-not-append): the pair skill's capture-timing prose states the
claude answer is read from the settled stop and describes the final-message
directive beside the read-only posture section; the panel reference documents
the leg contract as an OUTPUT-SHAPE rule (complete self-contained final
message, no background agents in a leg) — never a reasoning lens, preserving
panelist independence — and names the code directive as the sole injection
mechanism (prose documents, never re-injects). The JSON answer envelope shape
is unchanged; skill edits are prose-only.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/launch-config.ts:58 — READ_ONLY_DIRECTIVE, the sibling const the new directive matches in style
- src/agent/main.ts:1268 — the promptParts compose where the directive prepends
- test/agent-byte-pin.test.ts:294 — the six pinned composed-prompt strings that must be deliberately updated

**Optional** (reference as needed):
- src/pair/panel.ts:476 — leg argv builder confirming panel legs inherit the compose-site directive
- test/agent-run-capture-golden.test.ts — pins buildAgentLaunchArgv with an explicit prompt param; must stay green untouched
- plugins/keeper/skills/pair/SKILL.md:46 — capture-timing and envelope prose to revise in place
- plugins/plan/skills/panel/references/panel.md:10 — independence rules and the per-panelist prompt contract section
- docs/adr/0021-transcript-only-background-agent-gating.md — the recorded single-source-directive decision

### Risks

- The directive lands in every partner prompt; over-long or lens-shaped wording degrades panelist independence — keep it short and output-shape-only.
- Byte-pin updates that merely mirror the implementation would pin a mistake; re-derive each expected string from the intended composition order.

### Test notes

bun test with the updated byte-pin posture suite green; confirm the argv-golden
suite and the System-uniform suite pass untouched; grep that no other test pins
the old composed-prompt bytes.

## Acceptance

- [ ] Every `keeper agent run` composed prompt, for all harnesses and all posture combinations (bare, read-only, system, read-only plus system), carries the final-message contract directive in a fixed position, and the byte-pin suite pins the new composition exactly.
- [ ] The pair and panel skill prose documents the consolidated-final-message contract as an output-shape rule with the code directive named as the single injection source, phrased forward-facing with no history narration.
- [ ] The JSON answer envelope shape is unchanged and the full fast suite (bun test) is green with the argv-golden tests untouched.

## Done summary
Added an always-on final-message contract directive to the agent run prompt compose site, re-derived the byte-pinned posture compositions, and documented the contract in the pair/panel skill prose.
## Evidence
