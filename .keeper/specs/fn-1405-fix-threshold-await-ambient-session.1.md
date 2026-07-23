## Description

Findings F1 (kept) + F3 (merged-into-F1). Evidence path: at the epic tip
`cli/await.ts` binds the ambient subject as
`ownSessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null`, feeding the
`context-used-at-least` and `weekly-quota-at-most route:current` runtime
slots. The sibling commands resolve the subject through
`resolveSessionId(null, env)` (`src/commit-work/session-id.ts`), which falls
through `JOBCTL_SESSION_ID` -> `CLAUDE_CODE_SESSION_ID` -> `KEEPER_JOB_ID` —
the key a tracked Pi foreground session's exact-runtime leaf is stored under
(`cli/session-runtime.ts`, `cli/accounts.ts`). Route the threshold-await
ambient lookup through the same `resolveSessionId` helper so Pi-foreground
parity holds, without disturbing the pre-existing fn-713 self-exclusion
binding that `agents-idle`/`monitor-running` rely on (those stay
CLAUDE_CODE_SESSION_ID-scoped for recycle-safe self-exclusion; only the
runtime-slot subject resolution changes).

Files: `cli/await.ts` (ambient subject resolution for the runtime slots),
`src/commit-work/session-id.ts` (reused helper, read-only), and the
threshold-await test that must exercise the real env->leaf-key path rather
than only the injected `readContextEvidence`/`ownSessionId` seams (F3).

## Acceptance

- [ ] The runtime-slot ambient subject resolves via `resolveSessionId(null, env)`, honoring KEEPER_JOB_ID for tracked Pi foreground sessions.
- [ ] `agents-idle`/`monitor-running` self-exclusion behavior is unchanged.
- [ ] A test drives the real env->leaf-key resolution (KEEPER_JOB_ID set, CLAUDE_CODE_SESSION_ID unset) and asserts the Pi-foreground leaf is read, closing the F3 gap.

## Done summary

## Evidence
