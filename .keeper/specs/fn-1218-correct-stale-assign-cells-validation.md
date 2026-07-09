## Overview

The activation epic repointed the plan `configuredEfforts`/`configuredModels`
seam to the composed EFFECTIVE matrix (host provider `matrix.yaml` overlay,
embedded snapshot when absent), but assign-cells' header comment still asserts
axis validation "comes from the embedded subagents matrix only". The comment
now states the opposite of actual behavior — a reader of cell validation would
believe assign-cells rejects host-roster cells when it in fact validates
against the host axes. This is a one-line documentation correctness fix.

## Acceptance

- [ ] The `assign_cells.ts` header comment describes the effective-matrix
      validation seam accurately (embedded snapshot + host overlay when present).
- [ ] The still-accurate "NEVER reads model-selector.yaml" clause is preserved.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | gpt-5.5 orphaned guidance block is inert, gate-tolerated forward-provisioning (drift gate keys on research entries, which gpt-5.5 lacks); no user impact, remedy is only a confirmatory marker. |
| F2 | culled | — | Local forbidden-trailer regex in the slow e2e is a theoretical drift seam with auditor-verified current parity; prompt-driven close-out makes reimplementation the best proof — minor maintainability only. |
| F3 | kept | .1 | assign_cells.ts:23-25 comment asserts "embedded matrix only" but configuredEfforts/Models now read effectiveMatrix() (host-aware) — the comment states the opposite of behavior and misleads the next reader. |

## Out of scope

- The gpt-5.5 guidance-block orphan (F1) — deliberately left as gate-tolerated forward-provisioning.
- Coupling the wrapped-cell e2e sanitizer to the production trailer regex (F2) — theoretical drift, current parity verified.
