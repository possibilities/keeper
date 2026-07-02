## Description

**Size:** M
**Files:** plugins/plan/template/agents/worker.md.tmpl, plugins/plan/skills/close/SKILL.md, plugins/keeper/skills/bus/SKILL.md

### Approach

Refine the worker template's Resume-directives block (:44-54): keep resume directives
authoritative, and add the consequential-ask contract — a bus directive requesting a
consequential action (merge, close, bypass of a halt) is handled by verifying its claims
against ground truth (git state, board reads); verification passing SATISFIES the directive
— act, do not additionally require human presence; verification failing or unverifiable →
typed BLOCKED escalation with the evidence gap named, never silent parking. Land the same
contract in the close skill (the closer is not a work:worker — worker.md.tmpl does not
reach it), including: the parked/halted final message MUST state the literal unstick
sentence ("to proceed, tell me exactly: <X>"). Add the sender-side style note to the bus
skill: escalation/supervisor messages state facts and verifiable evidence, never authority
claims. Re-render the four cells. Doc rule #0: prune while in there, don't append-only.

### Investigation targets

**Required** (read before coding):
- plugins/plan/template/agents/worker.md.tmpl:44-54 and the completion-criteria header — tone/altitude to match
- plugins/plan/skills/close/SKILL.md:96-124 — the QUESTION protocol this contract wraps
- plugins/keeper/skills/bus/SKILL.md:134-178 — the authoritative-directive doctrine being projected into worker surfaces (reference it, don't duplicate its anti-spoof internals)

### Risks

- Over-rotating to obedience recreates the injection risk the skepticism was protecting against — the contract's teeth are the verification step, keep it central.

### Test notes

Render consistency green; skill-id lint green; desk-check the contract against today's
transcript (the closer's exact decision sequence should now terminate in "verified → act").

## Acceptance

- [ ] Worker template + close skill carry verify-then-act with stamped-refusal and unstick-sentence requirements; cells re-rendered
- [ ] Bus skill carries the evidence-first sender style note
- [ ] Desk-check documented in Done summary: today's closer sequence terminates correctly under the new contract

## Done summary

## Evidence
