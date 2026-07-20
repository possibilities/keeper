## Description

Finding F3 (evidence: `plugins/plan/src/verbs/unblock.ts` inlines a literal
copy of the lifecycle hook-set list — `'SessionStart', 'UserPromptSubmit',
'Stop', 'SessionEnd', 'Killed', 'RateLimited', 'ApiError', 'InputRequest',
'Notification'` — twice inside `claimantSessionIsLiveOrRecent`'s query,
while the identical list already exists as `TERMINAL_PROOF_LIFECYCLE_HOOKS_SQL`
at `src/commit-work/surface.ts:1059`). The `hasOrderedTerminalProof` predicate
was correctly extracted to `src/lifecycle-terminal-proof.ts`, but the hook-set
SQL fragment it depends on was not — leaving three literal copies that must
stay identical for the two callers to mean the same thing by "terminally
proven."

Promote `TERMINAL_PROOF_LIFECYCLE_HOOKS_SQL` into the shared
`src/lifecycle-terminal-proof.ts` module (alongside the predicate it feeds),
have both `src/commit-work/surface.ts` and `plugins/plan/src/verbs/unblock.ts`
import it, and delete the inline copies. Files: `src/lifecycle-terminal-proof.ts`,
`src/commit-work/surface.ts`, `plugins/plan/src/verbs/unblock.ts`.

## Acceptance

- [ ] The hook-set SQL literal exists in exactly one place (the shared module) and both callers import it.
- [ ] No behavioral change: the terminal-proof queries select the same lifecycle-tail events as before.
- [ ] Existing `saga-unblock` and commit-work terminal-proof tests pass unchanged.

## Done summary
Promoted TERMINAL_PROOF_LIFECYCLE_HOOKS_SQL into src/lifecycle-terminal-proof.ts and had src/commit-work/surface.ts and plugins/plan/src/verbs/unblock.ts import it, deleting the inline duplicate lifecycle hook-set SQL from both callers.
## Evidence
