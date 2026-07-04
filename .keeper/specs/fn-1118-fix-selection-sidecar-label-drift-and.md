## Overview

The post-scaffold selector writes a git-committed selection sidecar meant to
be a label_source-tagged dataset for later analysis, but a real selection is
tagged inconsistently: the schema type doc and the entire conformance suite
hardcode `heuristic-guided` while every runtime caller writes `selector-chosen`,
and the verb captures the tag verbatim so the tests never exercise the value
production actually persists. This follow-up reconciles that tag so the schema
doc, the tests, and the three runtime call sites all agree, and closes the two
coverage holes on the same sidecar/provenance surface (the malformed
`selection:` block guards and the string-valued `confidence` round-trip) while
the file is already open.

## Acceptance

- [ ] A real selection is tagged with ONE canonical `label_source` string,
      identical across the type doc, the test fixtures, and all three runtime
      callers (plan Phase 6.5g, defer Phase 4b, README verb entry); degrade
      rows keep `heuristic-default`.
- [ ] A test asserts the exact `label_source` a real runtime selection persists
      (the value the callers write), not a fixture-only constant.
- [ ] The malformed `selection:` block paths reject with `bad_yaml` under test.
- [ ] A string-valued `confidence` round-trips into the sidecar under test.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | selection_sidecar.ts:48 + tests hardcode `heuristic-guided` while all runtime callers write `selector-chosen`; verb captures verbatim so tests never exercise the real tag. |
| F2 | culled | — | ADR advisory only; the sidecar format + path rationale is already well-captured in the selection_sidecar.ts:1-24 header — no user impact, no next-reader surprise. |
| F3 | kept | .1 | The selection-block guards (assign_cells.ts:231-262) have zero negative-case coverage; bundled into task .1 on the same test file as F1. |
| F4 | kept | .1 | confidence is typed number|string but only the numeric form is tested; the string round-trip is uncovered, bundled into task .1 on the same sidecar surface as F1. |

## Out of scope

- A `docs/adr/` entry for the selection-sidecar format (F2 — the rationale
  already lives in the source header; declined at audit).
- Any change to the sidecar schema shape, the axis-validation path, or the
  selector-leg orchestration — this is a tag-reconciliation + coverage pass only.
