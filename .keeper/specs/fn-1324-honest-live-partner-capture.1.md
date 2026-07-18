## Description

**Size:** M
**Files:** src/agent/main.ts, src/agent/run-capture.ts, src/agent/pair-subcommands.ts, src/agent/dispatch.ts, test/agent-run-capture.test.ts, test/agent-pair-subcommands.test.ts, test/agent-run-capture-golden.test.ts, docs/agent-surface-contracts.md

### Approach

Make `timed_out` mean only that the caller's observation deadline elapsed. Preserve any bounded partial message, distinguish positive Partner liveness from unknown lifecycle evidence, and keep the exact nine-key envelope and exit-code contract. Terminal run-control writes and `--reap-window-on-terminal` must follow confirmed Partner termination rather than capture-command completion, so a timeout leaves the Partner inspectable and resumable.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/run-capture.ts:318-369,805-869 — exact answer envelope and timed-out partial capture
- src/agent/main.ts:1026-1090 — atomic result emission, terminal control marking, and optional reap
- src/agent/pair-subcommands.ts:248-353 — shared deadline plus in-flight show-last-message primitive
- src/agent/transcript-watch.ts:121-180 — live/terminal/unknown lifecycle evidence and death precedence
- test/agent-run-capture.test.ts:593-703 — timeout, partial, ambiguity, and death fixtures
- test/agent-pair-subcommands.test.ts:393-575 — bounded wait and partner_died fixtures

**Optional** (reference as needed):
- test/agent-transcript-background.test.ts:180-213,280-300 — partial text is retrievable but not a settled final answer
- test/agent-run-capture-golden.test.ts:13-40 — exact nine-key fixture

### Risks

- Panel/provider-leg consumers may treat a result file as their invocation's terminal artifact even while the Partner Harness remains live; keep invocation completion distinct from Partner lifecycle
- Output-write or teardown errors must not retroactively authorize termination after a timeout

### Test notes

Pin positive-live timeout, unknown-lifecycle timeout, partial/no-transcript guidance, skipped reap, unchanged terminal reap, and exact envelope shape in deterministic in-process tests.

## Acceptance

- [ ] `timed_out` never marks run control terminal or invokes terminal reap while Partner termination is unconfirmed
- [ ] Positive liveness yields “Partner still running” guidance; unknown evidence says only that termination was not observed
- [ ] Timeout output preserves bounded partial text and a usable transcript/show-last-message recovery path without claiming the partial is final
- [ ] Confirmed terminal and `partner_died` paths retain their existing precedence, exit codes, teardown posture, and exact nine-key envelope
- [ ] The focused agent capture, pair-subcommand, and golden tests pass

## Done summary

## Evidence
