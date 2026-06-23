## Description

Finding F1 (with F2 folded in). `findLastMessage`'s JSDoc
(`src/transcript-watch.ts:89-90`) states a tool-only final turn yields the
"defined empty signal" `found:true, text:null`. For claude that signal is
never produced: `claudeStopFromObject` excludes `stopReason === "tool_use"`
(line 296) and a thinking/tool-only turn yields no `assistantMessageText`,
so neither `sawStop` nor `sawAssistant` flips and the result is
`found:false`. The test `"tool-only final turn → found:true, text:null
(defined empty signal)"` (`test/pair-subcommands.test.ts:199`) asserts
`found:false` (line 209) — name written to the contract, assertion to the
code. F2: the inline comment at `test/pair-subcommands.test.ts:357` above a
`found:false, message:null` assertion reasserts the same `found:true`
framing and must move in lockstep.

Pick one resolution and make name, assertion, JSDoc, and the line-357
comment all agree: either (a) make a claude tool-only `assistant` turn
register as a stop so `found:true`, or (b) keep the current `found:false`
behavior and correct the JSDoc + test name + comment to state that a claude
tool-only turn reads as `found:false`. Confirm the keeper-side consumers
(`parseShowLastMessageJson` / `buildPairOutput` in keeper's
`src/pair-command.ts`) stay correct under the chosen story — both null
cases already map to `message:""`, so the behavior is benign either way;
this is a contract-coherence fix, not a behavior change.

## Acceptance

- [ ] The `findLastMessage` JSDoc, the test name at line 199, its assertion, and the comment at line 357 all describe the same empty-turn `found` semantics.
- [ ] keeper-side `parseShowLastMessageJson` / `buildPairOutput` remain correct under the chosen resolution (verified, not just assumed).

## Done summary

## Evidence
