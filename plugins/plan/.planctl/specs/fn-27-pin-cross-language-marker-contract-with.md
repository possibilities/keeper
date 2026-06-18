## Overview

The session-marker file is a cross-language contract: Python's
`session_markers.py::_write_marker` writes the bytes, and the TS guard
dispatchers read the same files independently. Today the field names and
`kind` values are kept byte-identical only by hand-rolled fixtures on each
side — nothing mechanical fails if `_write_marker` and the TS reader drift
apart. This adds a single end-to-end round-trip test so a future field
rename breaks a test instead of silently bricking the guards.

## Acceptance

- [ ] A test writes a real marker via the Python success path and reads it
      back through the actual TS dispatcher reader (or a true bun
      subprocess), asserting the parsed task identity matches.
- [ ] The test fails if a field name / `kind` value diverges between
      `_write_marker` and the TS reader.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | readMarker/read_marker skip a schema_version check, but no v2 schema exists and fail-open bounds the blast radius — speculative future-proofing. |
| F2 | culled | — | COMMIT_PATTERN misses sh -c payloads, but it is a deliberately soft, bypassable guard backstopped by the Stop guard, with no observed evasion case. |
| F3 | kept | .1 | No test round-trips a Python-written marker through the TS dispatcher; the cross-language contract is convention-only and unpinned. |
| F4 | culled | — | Marker/envelope task-id divergence path does not exist by design (the marker IS the task identity). |

## Out of scope

- schema_version validation on read (F1 — deferred until a v2 schema is actually introduced).
- Hardening COMMIT_PATTERN against `sh -c` wrappers (F2 — deferred until the wrapper-evasion case is observed in practice).
