## Description

**Size:** M
**Files:** test/panel-lifecycle-integration.test.ts, test/pair-panel.slow.test.ts, scripts/panel-smoke.ts, README.md, docs/problem-codes.md, docs/install.md

### Approach

Assemble the mandatory fake/injected incident gate across reservation, member execution, judge ownership, and cleanup, then provide one bounded operator smoke command that uses a unique request identity, a deliberately small configured panel, a hard outer timeout, explicit abort, and exact run-directory leak inspection. Document current retry and cancellation behavior, machine-visible failure meanings, and the Pi runtime requirement. The automated fast gate never launches models, subprocesses, or tmux; the real smoke remains an explicit post-landing operator action and cannot retry the CodexBar inquiry.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- test/pair-panel.test.ts:102 — injected panel effects are the fast-tier pattern.
- test/pair-panel.slow.test.ts:1 — real detached-process proofs are slow-gated and isolated from the default suite.
- CLAUDE.md:91 — fast tests forbid real subprocess, tmux, Worker, daemon, socket, or git execution.
- README.md:1 — keep the front door concise and point detailed failure semantics to owning docs.

**Optional** (reference as needed):
- docs/problem-codes.md — use only for stable machine/operator failure codes.
- docs/install.md — consolidate Pi Task runtime requirements rather than appending a parallel walkthrough.

### Risks

A smoke script that uses broad process matching could hide ownership defects or kill unrelated work. The smoke must not use the CodexBar question or trigger automatic retries, and its cleanup assertions must key only on the unique run directory and exact registered children.

### Test notes

The fast integration matrix must reproduce the incident shape with a recursive orchestration phrase and deterministic `no_message` legs, proving one run directory and configured member count. Add failed-quorum, timeout, partial-start, cancellation-during-judge, output-write failure, TERM-resistant child, exact tmux reap, and zero-survivor assertions. The slow test may use fake harness executables but no paid model calls; the operator smoke is separate.

### Detailed phases

1. Build an in-process incident regression around injected lifecycle ports.
2. Add slow fake-harness wrapper/tmux cleanup coverage under the existing gate.
3. Add a bounded operator smoke command with abort and exact survivor checks.
4. Consolidate operator and installation documentation.
5. Record the post-landing smoke and CodexBar retry-gate checklist.

### Alternatives

Retrying the original panel as validation is rejected because it is expensive and violates the incident gate. Broad `ps | grep` or session-wide tmux cleanup is rejected because it cannot prove ownership safety.

### Non-functional targets

Fast tests are deterministic and process-free; slow fake-harness tests are bounded; the operator smoke has a hard timeout, unique namespace, bounded output, and exact cleanup reporting.

### Rollout

After landing, run the fake gate, one small real panel, and one operator abort. Lift the CodexBar retry gate only when both runs launch exactly the configured member count once and leave no registered wrapper, judge, or tmux child.

## Acceptance

- [ ] A fake incident regression proves recursive orchestration text and `no_message` cannot create more than one run directory or one configured fan-out.
- [ ] Fast tests cover failed quorum, timeout, partial launch, caller cancellation, judge cancellation, output failure, and cleanup escalation without external processes.
- [ ] Slow fake-harness coverage proves terminal and aborted runs leave no exact registered wrapper or tmux target.
- [ ] A bounded post-landing smoke command reports launch count, terminal outcomes, cancellation settlement, and exact survivor count without using the CodexBar inquiry.
- [ ] Operator docs state retry safety, cleanup-failed handling, Pi compatibility requirements, and the gate for resuming the original design inquiry.

## Done summary
Added a fake incident regression proving one-run/one-fan-out ownership across recursive text and no_message legs, fast-tier coverage for failed quorum, timeout, partial launch, cancellation, output failure and cleanup escalation, slow fake-harness coverage proving exact wrapper/tmux teardown on both terminal and aborted runs, a bounded operator smoke script (scripts/panel-smoke.ts) with unique identity, hard timeout, explicit abort and exact survivor reporting, and consolidated README/install/problem-codes docs on retry safety, cleanup-failed handling, Pi compatibility, and the CodexBar retry-gate checklist.
## Evidence
