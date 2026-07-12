## Description

**Size:** S
**Files:** docs/adr/0042-edit-claims-and-risk-tiered-overlap-wiring.md, CONTEXT.md, CLAUDE.md, docs/problem-codes.md

### Approach

Revise ADR 0042 IN PLACE — it is Status: Proposed / never-landed, so do NOT move it to
`superseded/` and do NOT mint a supersession. Rewrite title + Context + decisions #1-#3
(edit_claims field, overlap gate, risk-tiered wiring) to the base-freshness gate /
rebase-cadence design; KEEP decision #4 (conflicted-file-set capture = task `.6`) and #5's
measurement framing (task `.7`); PRUNE the dead edit-claims prose rather than appending beside
it. In CONTEXT.md remove the now-dead `Edit claim` (L26) + `Overlap gate` (L27) terms and add
canonical `base-drift` / `base-freshness` / `lane-base` entries relating them to `Merge-gate`
(L86). Add ONE producer-only base-freshness guardrail clause to the CLAUDE.md merge-gate line
(L114) — one line, not a paragraph. Add a docs/problem-codes.md row ONLY if `.4` minted a new
distress code (else it reuses `worktree-merge-conflict`).

### Investigation targets

*Verify before relying — the repo moves.*

**Required:**
- docs/adr/0042-edit-claims-and-risk-tiered-overlap-wiring.md — Status line + decisions #1-#5
- CONTEXT.md:26, :27, :86 — Edit claim / Overlap gate / Merge-gate entries
- CLAUDE.md:114 — the worktree/merge-gate invariant line
- docs/problem-codes.md — the `worktree-*` distress rows

### Test notes

`bun scripts/lint-claude-md.ts` stays green (size + no re-narration). MADR headings preserved in the ADR.

## Acceptance

- [ ] ADR 0042 documents the base-freshness/rebase-cadence design (revised in place, not superseded), keeping the conflicted-file-capture and measurement decisions.
- [ ] CONTEXT.md no longer defines the dropped Edit claim / Overlap gate terms and defines base-drift/base-freshness relative to Merge-gate.
- [ ] Any new distress code has a problem-codes.md row; the CLAUDE.md merge-gate line names the producer-only base-freshness rule.

## Done summary

## Evidence
