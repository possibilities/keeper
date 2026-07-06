## Overview

The hermes events shim carries byte-identical copies of the birth-record
`(pid, start_time)` parsers, guarding the recycle witness that keeps a
hard-killed adopted job row from being resurrected onto a stranger's pid.
The copies are marked "DRIFT GUARD: byte-identical" but nothing enforces
that parity under test, so a silent drift from the birth-record originals
would ship uncaught and mis-attribute an adopted row on pid reuse.

## Acceptance

- [ ] The shim's start_time parsers are pinned by a test that fails on any drift from the birth-record originals.
- [ ] The parity is anchored to a shared source of truth (a fixture the birth-record test also consumes, or a direct equivalence assertion), not two independently-maintained expectations.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | hermes-events-shim.ts:228/250 hold byte-identical start_time parsers whose DRIFT GUARD comments promise parity with birth-record originals, but hermes-shim.test.ts pins none — untested drift breaks the (pid,start_time) recycle witness. |
| F2 | culled | —  | fn-id/version tokens in the new db.ts migration comments are convention-consistent with the pervasive existing pattern (v99->v100 (fn-1024.1) ... v106->v107 (fn-1102.1)); zero user impact, no surprise, and a rule-#0 purge would be a deliberate tree-wide sweep. |

## Out of scope

- Purging fn-id/version provenance tokens from db.ts migration comments (F2) — that is a deliberate tree-wide convention decision, not a rider on this follow-up.
- Any change to the parsers' runtime behavior; the copies are correct today and this work only adds enforcement of their parity.
