## Description

Resolves F3 (with F2 merged in) from the fn-1205 close audit. Evidence
path: `plugins/keeper/plugin/hooks/wrong-tree-guard.ts` header lines 7-9
narrate a past incident in past tense ("a lane worker wrote src/* into the
shared main checkout while its lane sat clean, starving the repair route"),
violating CLAUDE.md rule #0's ban on past-tense provenance in code
comments. F2 (no `docs/adr` entry for the new hook) shares this task
because its remedy is the same canonical-home ADR.

Files:
- `docs/adr/` — add a new ADR entry capturing the shared-checkout-dirtying
  rationale and the wrong-tree-guard best-effort-audit decision (this is
  the canonical home for the narrative currently in the code comment).
- `plugins/keeper/plugin/hooks/wrong-tree-guard.ts` — rewrite the header
  comment to be forward-facing (what the guard does now), removing the
  past-tense incident narrative.

## Acceptance

- [ ] New `docs/adr` entry records the incident rationale and the guard decision.
- [ ] `wrong-tree-guard.ts` header carries no past-tense provenance; describes current behavior only.

## Done summary
Added docs/adr/0025-wrong-tree-write-guard.md capturing the shared-checkout-dirtying rationale and the guard's decision; rewrote wrong-tree-guard.ts header to be forward-facing, pointing to the ADR instead of narrating the incident.
## Evidence
