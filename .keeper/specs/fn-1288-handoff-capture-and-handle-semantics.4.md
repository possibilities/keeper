## Description

**Size:** M
**Files:** cli/agent.ts, src/agent/launch-handle.ts, src/pair/panel.ts, plugins/keeper/skills/pair/SKILL.md, plugins/keeper/skills/handoff/SKILL.md, plugins/plan/skills/panel/SKILL.md

### Approach

Align the documented and validated launch-handle semantics across the three surfaces — semantics only, storage keys untouched. In the CLI layer: make the cli/agent.ts header contract comment and help text state the unified model (a caller-supplied handle is the dedup key; a dead target resumes by handle; a live target refuses and routes to the Agent Bus; each surface's idempotency scope is explicit — partner names host-global among tracked jobs, handoff slugs host-global event-sourced with dup→exit 3, panel slugs display/discovery-only with the opaque request identity as the real handle), and align any divergent validation/error wording in the handle-resolution and panel slug paths to say the same thing (touch src/pair/panel.ts doc/validation wording only — fn-1285 owns its lifecycle struct surface). In the skill layer: update the handoff runbook with the capture fire-and-wait recipe (request with --capture, then the standard chunked-wait loop against the envelope path, timeout-detaches-waiter semantics, capture-is-not-the-default cost note) and align pair/handoff/panel skill prose to the unified handle vocabulary, citing the fn-1287 contracts doc for the shared envelope and wait mechanics instead of restating them. Forward-facing prose only.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves (fn-1282 rewrites cli/agent.ts and launch-handle.ts before this runs).*

**Required** (read before coding):
- cli/agent.ts:1-35 — the header contract comment stating run/wait/panel handle addressing
- src/agent/launch-handle.ts — post-fn-1282 handle resolution the prose must match
- plugins/keeper/skills/handoff/SKILL.md — the fire-and-forget runbook gaining the capture recipe
- docs/agent-surface-contracts.md — the fn-1287 doc this task cites (verify its final section names)

**Optional** (reference as needed):
- src/pair/panel.ts — slug/request_id doc + validation wording (coordinate with landed fn-1285 shape)
- CONTEXT.md — the Launch handle glossary entry whose scope claims this prose must agree with

### Risks

- Contradicting the fn-1287 glossary/contract wording — read both before writing; the doc wins on wording disputes.
- Drifting into behavior change in panel.ts — only doc comments and message wording are in scope there.

### Test notes

plugins/plan consistency suite must stay green (skill tokens retained). Handoff/panel CLI test suites green with no behavioral assertions changed.

## Acceptance

- [ ] The pair/handoff/panel CLI contracts and skill runbooks state one consistent handle model (dedup, resume-if-dead, message-if-live, per-surface scope) with no storage-key change
- [ ] The handoff skill documents the capture fire-and-wait recipe end-to-end, including timeout-detach semantics and the opt-in cost note
- [ ] Shared envelope/wait mechanics are cited from the contracts doc, not re-narrated
- [ ] Consistency and CLI test suites pass unmodified

## Done summary
Launch-handle semantics aligned across dispatch/pair/panel surfaces + the three skill runbooks; operator re-run 160/0 + 53/0 across five agent suites; landed via plain-git escape (multi-session claim wedge, sessions discharged) as f3f331fb on the epic lane
## Evidence
- Commits: f3f331fb
- Tests: bun test agent-panel-cli+pair-panel+agent-launch-handle 160/0 (operator re-run), bun test agent-dispatch+agent-launch-handle-depgraph 53/0