## Description

Addresses F1 (status enum drift, src/types.ts:303 vs src/subagent-invocations.ts:91 /
src/reducer.ts:818,890). Three file-touch points share the same root cause:

1. `src/types.ts:303` — widen `SubagentInvocation.status` from `"running" | "ok" | "error"`
   to `"running" | "ok" | "failed" | "unknown"`. Update the adjacent doc comment (~line 292)
   from `running → ok / running → error` to list all terminal transitions.
2. `README.md:70` — change `running | ok | error` to `running | ok | failed | unknown`.
3. `README.md:432` — change `status running|ok|error` to `status running|ok|failed|unknown`.
4. `src/db.ts` migration doc comment — update any reference to `'ok' / 'error'` terminal states
   to match `'ok' / 'failed' / 'unknown'`.
5. Grep for any arm that writes the literal value `"error"` into `status`; verify none exist.

No logic changes — this is a type-annotation and comment-only fix.

## Acceptance

- [ ] `SubagentInvocation.status` in `src/types.ts` is `"running" | "ok" | "failed" | "unknown"`
- [ ] Doc comment at `src/types.ts:~292` lists all three terminal transitions
- [ ] `README.md` lines ~70 and ~432 show the corrected enum
- [ ] `src/db.ts` migration comment updated
- [ ] `grep -r '"error"' src/ | grep status` returns no hits for new `"error"` writes
- [ ] `bun run typecheck` passes

## Done summary
Widened SubagentInvocation.status to 'running' | 'ok' | 'failed' | 'unknown' in src/types.ts and synced doc comments in types.ts, db.ts migration, and README. Updated one readiness test that used the old 'error' literal.
## Evidence
