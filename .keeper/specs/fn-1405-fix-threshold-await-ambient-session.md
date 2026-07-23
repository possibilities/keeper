## Overview

The `context-used-at-least` and `weekly-quota-at-most route:current` threshold
awaits resolve their ambient subject through the narrow
`ownSessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null` binding, whereas
the sibling read surfaces (`keeper session runtime`, `keeper accounts inspect`)
resolve it through the general `resolveSessionId(null, env)` helper that falls
through to `KEEPER_JOB_ID`. For a tracked Pi foreground session
`CLAUDE_CODE_SESSION_ID` is unset, so these awaits fail loudly
(`target-ended` exit 4 / `route-unresolved` exit 1) instead of reading the
session's real exact-runtime leaf — a parity gap that makes a shipped,
foreground-scoped feature unusable from a first-class supported surface.

## Acceptance

- [ ] The threshold-await ambient subject is resolved with the same helper the sibling runtime/accounts reads use, so a tracked Pi foreground session reads its own exact-runtime leaf.
- [ ] `context-used-at-least` and `weekly-quota-at-most route:current` succeed from a Pi-foreground env (KEEPER_JOB_ID set, CLAUDE_CODE_SESSION_ID unset), matching Claude-foreground behavior.
- [ ] A test exercises the real env->leaf-key resolution path (not only the injected `readContextEvidence`/`ownSessionId` seams).

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | cli/await.ts binds ownSessionId=CLAUDE_CODE_SESSION_ID while sibling reads use resolveSessionId(null,env) honoring KEEPER_JOB_ID; tracked Pi foreground sessions cannot use the threshold awaits. |
| F2 | culled | — | boundArtifacts global oldest-first 256 eviction is diagnostic-only staleness under >256 native sessions, never affects serving; below the keep bar. |
| F3 | merged-into-F1 | .1 | F3 (no test of the real env->leaf-key ambient path) shares F1's root cause; the F1 fix lands the missing Pi-foreground resolveSessionId test. |

## Out of scope

- The global 256-artifact route eviction bound (F2) — diagnostic-only staleness under >256 distinct native sessions, deliberately left as-is.
- Any change to the coalesced runtime producer or model-serving path.
