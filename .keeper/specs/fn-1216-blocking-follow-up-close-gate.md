## Overview

When the close audit's follow-up epic corrects a consumer-observable flaw in what the source epic ships, closing the source lets every dependent build on the flaw. This epic adds an explicit blocking disposition: close-planner decides it, close-finalize mints the follow-up as a durable gate (one committed pointer, blocks_closing_of), a new readiness predicate holds the source's close row until the follow-up lands, and a second closer adopts and closes. Non-blocking follow-ups stay byte-for-byte today's flow. Decision record: docs/adr/0028-blocking-followup-close-gate.md; vocabulary: CONTEXT.md "Blocking follow-up".

## Quick commands

- cd plugins/plan && bun test saga-close-finalize.test.ts   # truth-table incl. the gate branch
- bun test test/readiness.test.ts                           # close-row gate predicate
- keeper query epics --filter epic_id=<followup> | jq '.rows[0].blocks_closing_of'   # folded pointer visible

## Acceptance

- [ ] A blocking verdict holds its source epic open (close row blocked:close-followup) until the follow-up is done and close-idle, then a re-dispatched closer adopts it and closes the source
- [ ] Every dependent of the source stays dep-on-epic blocked for the gate's whole duration with no new wiring
- [ ] Non-blocking and legacy verdicts drive today's behavior unchanged, and a deleted-while-gated follow-up surfaces as a sticky needs-human, never a silent close
- [ ] Armed-mode boards arm the follow-up so the gate cannot wedge

## Early proof point

Task that proves the approach: ordinal 2 (the saga blocking-branch truth-table). If it fails: task 1's fold + predicate still land independently; re-scope the saga branch against what the truth-table showed before touching any prose.

## References

- docs/adr/0028-blocking-followup-close-gate.md — the decision: durable board gate over session-held monitor, single authoritative pointer, dep substitution
- CONTEXT.md "Blocking follow-up" — the term
- Overlap: the apply-selection verdict seam epic rewrites the close skill's selection beat and threads close-finalize's selection-verdict flag — this epic is dep-gated behind it and builds on its landed contract (direct SKILL.md collision, semantic close_finalize coupling)
- src/reducer.ts:8065 syncEpicDepsReverse — the reverse-derivation precedent the gate's read-time source state follows
- src/readiness.ts:942-982 — dep-on-epic done-AND-idle, the gating lever the whole design rides

## Docs gaps

- **plugins/plan/README.md**: update — close-outcome enum and close-flow prose (a task deliverable here)
- **plugins/plan/CLAUDE.md**: update — one status-blind scaffold carve-out guardrail line (a task deliverable here)
- **CLAUDE.md (root)**: judgment call — add a line only if the held-open gate reads as a stuck board in practice

## Best practices

- **One authoritative pointer, derive the rest:** a second committed pointer is a dual-write tear waiting for a crash boundary [saga/outbox literature]
- **Re-read the authoritative gate at stamp time:** the close decision never trusts a derived cache [saga reread-value countermeasure]
- **Idempotent child identity:** discovery by durable pointer is what makes never-blind-re-scaffold enforceable [Kubernetes ownerReferences]
- **Malformed decisions fold safe without throwing:** strict typed validation at submit; absent means legacy non-blocking
- **O(1) per-tick predicate:** one reverse index per readiness pass, never a per-close-row scan
