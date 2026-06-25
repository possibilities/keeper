## Overview

The handoff doc-spill fix moved the brief from the wire to a CLI-written
spill file whose path the daemon reads verbatim, turning a same-user RPC
into an arbitrary-file-read primitive: a foreign caller hitting
`request_handoff` can name any daemon-readable path and exfiltrate its bytes
into the queryable `handoffs` projection. This follow-up constrains the read
to the spill directory and verifies the daemon's loud-fail branches that the
original tests left unexercised.

## Acceptance

- [ ] The daemon rejects a `doc_path` that does not resolve under `resolveHandoffSpillDir()` with a loud `ok:false`, before reading the file.
- [ ] The daemon's empty-file and oversized-file `ok:false` branches are covered by tests asserting their error strings.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | daemon.ts:2601 unconstrained `readFileSync(msg.doc_path)` is an arbitrary-file-read primitive; constrain to the spill dir prefix. |
| F2 | culled | — | Comment-trim only (daemon.ts:2592-2598); correct if verbose, no user impact. |
| F3 | kept | .1 | daemon.ts:2613/2623 empty/oversized `ok:false` loud-fail branches are unexercised; the epic's central contract. |
| F4 | culled | — | CLI spill cleanup (handoff.ts:280) is best-effort with an age-out backstop, low value. |

## Out of scope

- The NARRATION_BLOCK comment trim at daemon.ts:2592-2598 (F2, culled).
- CLI spill-cleanup test coverage (F4, culled — best-effort + age-out backstop).
