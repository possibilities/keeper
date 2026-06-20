## Overview

The comment-only scrub verifier's second witness (transpile-output equality)
calls `ts.transpileModule` with no `fileName`, so any module-scope generic
arrow (`<T>() => ...`) is mis-parsed as JSX and the transpile arm diverges
spuriously. This is a dev-gate correctness fix: a future scrub touching a
generic-arrow file would get a false failure, or a worker would learn to
ignore the transpile arm and lose the second witness entirely. Token-equality
(the authoritative witness) is unaffected, so no bad code ever shipped.

## Acceptance

- [ ] The transpile witness passes a correct `fileName` to both
      `transpileModule` calls so generic arrows parse as TS, not JSX.
- [ ] A fixture covering a module-scope generic arrow exercises the
      transpile path and proves it no longer false-positives.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | scripts/assert-comment-only.ts:172-177 both transpileModule calls omit fileName; module-scope generic arrows mis-parse as JSX and spuriously fail the transpile witness. |
| F2 | merged-into-F1 | .1 | F2 (missing generic-arrow fixture) is the test half of F1's fileName fix — same root cause and file-touch set; folded into F1's task. |

## Out of scope

- The 14 comment-only source scrubs and the CLAUDE.md/README changes — audited clean, token-equality confirmed byte-identical emit.
- Any change to the authoritative token-equality witness or the protected-pattern guard — both sound.
