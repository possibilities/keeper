## Overview

A wrapped worker burned ~15 of 19 provider-leg launches on the
wrapped-guard's inert-argument gate and mis-classified the guard denials
as a leg failure (TOOLING_FAILURE), because the manifest's failure map
has no guard-denied branch and the denial text is opaque. This epic
verifies the guard lexer against POSIX quoting (fixing only proven
wrongly-denies divergences), makes the run-gate denials actionable, adds
the guard-denied branch to the wrapped-worker manifest with rigorous
launch-shape guidance, and recompiles the generated worker cohort. End
state: a mis-quoted launch produces one self-explaining denial that
steers the worker to the correct shape in the next attempt.

## Quick commands

- `bun test test/wrapped-guard.test.ts`
- `bun test plugins/prompt/test/oracle/render-plugin-templates.test.ts`
- `bun run typecheck`

## Acceptance

- [ ] The run-gate denial names the construct, states expected-vs-received positional counts with a bounded offending-token excerpt, and carries the do-not-retry-same-shape steer to the system-file/quoting contract.
- [ ] The wrapped manifest treats a guard-denied launch as reshape-and-retry (bounded), never an envelope-absent TOOLING_FAILURE; launch and resume templates mandate the trivially-parseable shape.
- [ ] The CVE deny corpus never flips; any lexer change is a proven wrongly-denies fix mirrored to grant-guard's copy only.

## Early proof point

Task that proves the approach: ordinal 1 (the red-repro corpus seeded
from the real failing commands). If the lexer proves shell-correct: the
lock test IS the deliverable for that arm — no fabricated lexer change.

## References

- docs/adr/0050-wrapped-delegation-guard.md — the allowlist decision this stays inside (no scope change, no amendment)
- Witness: fn-1354.2 block, session 9897dd3c, ~/docs/keeper-review-remediation.md 07-18 18:3x
- The five mirrored lexer copies — propagation deliberately bounded to grant-guard; derivers.ts is fold-path and categorically out of scope

## Docs gaps

- none beyond the manifest partial itself (the doc deliverable); denial taxonomy stays hook-local

## Best practices

- **Make the sanctioned launch trivially parseable; free text lives in files** [OWASP / shell-quote CVE lineage]
- **Fix only wrongly-DENIES divergences; never loosen toward bash where the deny corpus weakens** [asymmetric hardening]
- **A denial an agent consumes is a prompt for its next attempt: construct + expected-vs-received + an explicit do-not** [agent-error design]
