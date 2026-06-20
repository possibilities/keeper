## Overview

Cleanup left over from the fn-756 approval strip: the autopilot `Verb` union
was collapsed to `"work" | "close"`, but the retry-dispatch verb surface
still carries a third `"approve"` member that can never occur (no `approve::`
dispatch exists to retry). Collapse it and fix the now-false "mirrors the Verb
union" comment. Dead/inconsistent surface, not a correctness bug.

## Quick commands

- `cd ~/code/keeper && grep -rn '"approve"' src/rpc-handlers.ts src/server-worker.ts` → empty
- `cd ~/code/keeper && bun test` → green

## Acceptance

- [ ] `RetryDispatchVerb`, `RETRY_DISPATCH_VERBS`, and the three server-worker.ts verb unions are `"work" | "close"`; the stale comment is corrected; `bun test` stays green.
