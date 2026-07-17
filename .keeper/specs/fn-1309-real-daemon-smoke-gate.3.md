## Description

**Size:** S
**Files:** src/autopilot-worker.ts, docs/testing.md, scripts/test-gate.ts

### Approach

Make the smoke gate authoritative where ADR 0073 places it: epic close-finalize runs the named smoke gate when the epic's landed diff touches the daemon Load surface — membership decided by the checked-in roots manifest the reload fingerprint already uses, through one seam, so the gated and hashed boundaries cannot disagree. A non-daemon epic's finalize is unchanged. A smoke failure surfaces through the existing finalize-suite-red path (same operator visibility), never as a silent skip. Document the gate, its conditional, and the one-retry policy in docs/testing.md, replacing (not appending beside) any wording the carve-out supersedes.

### Investigation targets

*Verify before relying.*

**Required** (read before coding):
- src/autopilot-worker.ts — the close-finalize suite selection and the finalize-suite-red surfacing path
- src/ (roots manifest consumer) — the Load-surface membership seam the conditional must reuse, never a second path list
- docs/testing.md — the section the carve-out revises

### Risks

- The load-surface test must read the same manifest seam as the reload fingerprint; a second hand-maintained list is the drift this repo's rules exist to prevent.

## Acceptance

- [ ] A finalize whose landed diff touches the Load surface runs the smoke gate; one that does not is byte-identically unchanged
- [ ] A smoke failure surfaces through the finalize-suite-red operator path
- [ ] docs/testing.md documents the gate, conditional, and retry policy

## Done summary

## Evidence
