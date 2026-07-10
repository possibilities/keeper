## Description

**Size:** S
**Files:** src/agent/triple.ts, src/agent/main.ts, test/agent-presets.test.ts

### Approach

Operator legibility surfaces. `extractHostTriples`/`hostTripleRefs` harvest the nested `dispatch:` map as labeled refs (one per verb, e.g. `dispatch.work`) and stop harvesting the removed worker/escalation fields, so `providers check` lints every dispatch triple against the enumerated launch cube (well-formed off-cube = drift exit 9, malformed = fault exit 1 — existing semantics, new refs). `presets list` prints the resolved per-verb table — configured triple or the floor each verb resolves to, flagging floored rows — in both human and JSON output (extend the existing presets-list envelope, no breaking field renames). Author against fn-1241's landed cutover: these verbs load the matrix via the v2 loader, and its committed-v2-example test pattern is the model for the new cases.

### Investigation targets

*Verify before relying — fn-1241 rewires these exact verbs before this dispatches.*

**Required** (read before coding):
- src/agent/triple.ts:307-337 + :356-374 — hostTripleRefs/extractHostTriples harvest to extend
- src/agent/main.ts:2126 — the lintHostTriples call site in providers check
- src/agent/main.ts:1704-1712 — presets list human+JSON output to extend
**Optional** (reference as needed):
- test/agent-presets.test.ts — existing envelope assertions; fn-1241's v2-example verb tests once landed

### Risks

- fn-1241 lands the v2 loader cutover in these verb bodies — build on its landed state, never re-introduce a v1 loadMatrix call.

### Test notes

Cases: a configured dispatch table renders fully in list output; a floored verb is visibly marked; an off-cube dispatch triple trips providers check drift exit; JSON shape asserted. Feed the committed v2 example matrix via KEEPER_CONFIG_DIR fixtures.

## Acceptance

- [ ] providers check reports a well-formed off-cube dispatch triple as drift and a malformed one as a fault, naming the verb key
- [ ] presets list shows every dispatch verb's resolved value and marks floored rows, in human and JSON output
- [ ] Both verbs pass against the committed v2 example matrix under fixture config

## Done summary

## Evidence
