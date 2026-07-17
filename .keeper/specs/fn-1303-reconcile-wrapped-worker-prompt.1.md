## Description

Finding F1 (evidence: plugins/plan/template/_partials/worker-implement-wrapped.md
line 37, the "Wait in chunks" paragraph). Task .4 sharpened lines 24 and 33 of
this partial to the transfer-not-title rule ("cleanup is daemon-owned by the run
handle/window identity, not by a title"; "the bare task-ID name is display-only")
and rewrote the cold-restart paragraph (line 35) to key on the exact
shared-session/window identity resolving to a live leg and resume by handle. But
the "Wait in chunks" paragraph (line 37) still reads "On a retry that finds a
stale same-name leg still live in the shared `wrapped` session, take it over by
its run handle... rather than double-launching a second `<task-id>` leg." The
"finds a stale same-name leg... take it over" framing describes the discovery-by-
name adoption the epic retires, contradicting the strengthened rule.

Files:
- plugins/plan/template/_partials/worker-implement-wrapped.md

Reconcile that paragraph so takeover keys on the already-captured run handle (or a
fenced transfer), never on discovering a same-name window — matching the phrasing
the cold-restart paragraph (line 35) already uses. Do not re-narrate history or
add fn-ids; forward-facing guidance only.

## Acceptance

- [ ] The "Wait in chunks" paragraph no longer frames takeover as discovering/adopting a same-name leg; it keys strictly on the captured handle or a fenced transfer
- [ ] The partial's transfer-not-title rule reads consistently across all paragraphs
- [ ] bun scripts/lint-claude-md.ts stays green if touched; no provenance leakage introduced

## Done summary

## Evidence
