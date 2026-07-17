## Overview

The durable wrapper-leg ownership epic retired title-based leg discovery in
favor of the daemon-owned durable owner tuple, and sharpened the wrapped-worker
prompt partial to the transfer-not-title rule. One paragraph was missed: the
"Wait in chunks" step still instructs a worker to take over a leg it "finds"
by same-name in the shared session, contradicting the strengthened rule two
paragraphs up. This is a docs reconciliation so the shipped worker guidance
stops self-contradicting on the epic's central rule.

## Acceptance

- [ ] The "Wait in chunks" paragraph keys takeover on the captured run handle / fenced transfer, never on discovering a same-name window
- [ ] No paragraph in the partial instructs same-name adoption; the transfer-not-title rule reads consistently end to end

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | worker-implement-wrapped.md line 37 "Wait in chunks" still says "finds a stale same-name leg... take it over", contradicting the strengthened "not by a title" rule at lines 24/33 that task .4 claimed to reconcile. |
| F2 | culled | —  | Functionally correct under SQLite dynamic typing; redeclaring pane_generation TEXT costs a schema migration for zero behavior change. |
| F3 | culled | —  | Theoretical portability nit; deployment targets place env at /usr/bin/env, so no concrete user impact. |

## Out of scope

- pane_generation column-type honesty (F2) — functionally correct, not worth a migration
- /usr/bin/env path portability (F3) — no concrete impact on supported targets
