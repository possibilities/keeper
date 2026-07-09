## Description

Finding F3 (evidence path: `plugins/plan/src/verbs/assign_cells.ts:23-25`
vs `plugins/plan/src/models.ts` `configuredEfforts`/`configuredModels`).
At the epic tip those two functions return `effectiveMatrix().efforts` /
`.models` — the host-aware composed matrix (host provider `matrix.yaml`
overlay, embedded snapshot when absent) — and the `models.ts` docstring
names assign-cells as an inheritor of that effective seam. But the
assign-cells header comment still reads "axis validation comes from the
embedded subagents matrix only (configuredEfforts/configuredModels)",
which is now the opposite of actual behavior: with a host `matrix.yaml`
present, assign-cells validates against the host provider axes.

File to change: `plugins/plan/src/verbs/assign_cells.ts` — update the
header comment to describe the composed EFFECTIVE matrix (embedded snapshot
+ host overlay when present). Keep the adjacent "NEVER reads
model-selector.yaml" clause verbatim — it is still accurate
(matrix.yaml is not model-selector.yaml).

## Acceptance

- [ ] The header comment names the effective/composed matrix as the
      validation source, not "embedded ... only".
- [ ] The "NEVER reads model-selector.yaml" clause is preserved.
- [ ] No behavioral code change — comment-only edit.

## Done summary

## Evidence
