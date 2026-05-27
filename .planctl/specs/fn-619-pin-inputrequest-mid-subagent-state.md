## Overview

The fn-617 audit found one behavioral asymmetry that is untested: InputRequest flips jobs.state to 'stopped' even when a subagent_invocations row is running, while Stop and ApiError explicitly skip the flip in that case. The distinction is intentional (a human question really blocks forward progress) but nothing pins it — a future "consistency" edit could silently add the sub-agent guard to InputRequest and break the feature for multi-agent sessions.

## Acceptance

- [ ] A reducer test asserts that an InputRequest event on a session with a running subagent_invocations row still flips jobs.state to 'stopped' and stamps the (last_input_request_at, last_input_request_kind) pair
- [ ] The test passes under bun test

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F6     | kept   | .1   | Behavioral asymmetry (InputRequest flips mid-sub-agent; Stop/ApiError don't) is untested — silent regression risk |
| F1     | culled | —    | Sub-agent guards documented in reducer.ts JSDoc lines 36–75; planctl spec is a historical artifact, not a gap |
| F8     | culled | —    | dispatchLine passes the full parsed object to matchAskUserQuestion; array-walking is already unit-tested at position:"middle" |

## Out of scope

- Amending the fn-617 task .1 spec retroactively (JSDoc already covers provenance)
- dispatchLine integration tests for position:"middle" (covered by existing matchAskUserQuestion unit tests)
