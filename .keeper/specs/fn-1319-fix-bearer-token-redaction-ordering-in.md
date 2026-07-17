## Overview

The pre-boot death-notice redaction routine (`redactAbortEvidence`) leaks an
opaque, non-shape-matching bearer token into the persisted notice: on an
`Authorization: Bearer <token>` line the key-denylist regex matches the
`AUTH` arm, captures the literal word `Bearer` as its value and redacts THAT,
which also strips the `Bearer ` prefix the dedicated bearer regex needs — so
the token survives every remaining arm. This is a security correctness fix to
a routine whose stated intent is to fail toward MORE redaction; it ships with
the regression test that currently only exercises a JWT-shaped bearer.

## Acceptance

- [ ] `Authorization: Bearer <opaque-non-JWT-token>` through `redactAbortEvidence` redacts the token, not the scheme word
- [ ] Existing JWT-shaped bearer and key-denylist redaction cases still pass; SHAs/UUIDs still preserved
- [ ] A regression test directly covers the opaque-bearer path

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | redactAbortEvidence AUTH-key arm eats `Bearer` and defeats the bearer regex, leaking an opaque non-JWT token into the persisted notice (src/provider-leg-death-notice.ts:263). |
| F4 | merged-into-F1 | .1 | F4 (missing opaque-bearer redaction test) shares F1's root cause; the F1 ordering fix lands with the Authorization: Bearer opaque-non-JWT regression test. |
| F2 | culled | — | capture-pane -e control-sequence passthrough is advisory defense-in-depth on a local same-user artifact, triggered only by manually cat-ing the raw blob; below the keep bar. |
| F3 | culled | — | Born-working lift is structurally idempotent via WHERE state = 'stopped'; the missing re-announce idempotency test is a low-priority nicety with no correctness gap. |

## Out of scope

- Stripping non-SGR terminal control sequences from the capture (F2 — advisory, culled).
- A direct re-announce idempotency test for the born-working lift (F3 — structurally guarded, culled).
- Replacing the interim inline denylist with the shared secrets pattern list (deferred to that ADR).
