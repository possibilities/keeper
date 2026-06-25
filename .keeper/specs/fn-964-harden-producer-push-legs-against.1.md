## Description

Source: finding F1 (with TG2 folded in). Evidence path:
`src/autopilot-worker.ts:2157` (`finalizeEpic` push leg) and
`src/autopilot-worker.ts:2351` (`recoverWorktrees` push leg) both call
`await run(["push"], { cwd })` with NO `env`. `spawnGitExec`
(`src/commit-work/git-exec.ts:67`) passes `env: undefined` when no env
is given, inheriting ambient `process.env` with `stdin: "ignore"` — but
git's askpass / credential helper opens `/dev/tty` directly, so a
credential-needing `origin` hangs the producer step. `GIT_TERMINAL_PROMPT`
is set nowhere globally (only in `src/commit-work/push.ts:198`, which
deliberately hardens exactly this). Pass `{ cwd, env: { GIT_TERMINAL_PROMPT:
"0" } }` to both `run(["push"], …)` calls so a credential prompt fails
fast (surfacing the existing sticky DispatchFailed) instead of hanging the
reconcile cycle. This also closes TG2 (the untested push-credential path):
the env hardening is what makes the prompt path fail-fast and assertable.

## Acceptance

- [ ] Both `run(["push"], …)` legs at :2157 and :2351 pass `env: { GIT_TERMINAL_PROMPT: "0" }`.
- [ ] A credential-needing push fails fast (classified failure / sticky DispatchFailed), no `/dev/tty` prompt.
- [ ] Behavior matches the commit-work push leg's `GIT_TERMINAL_PROMPT=0` pattern.

## Done summary
Pass env { GIT_TERMINAL_PROMPT: 0 } to both producer push legs (finalizeEpic :2157 and recoverWorktrees :2351) so a credential-needing origin fails fast instead of hanging the reconcile cycle, matching the commit-work push leg. Added a recover-leg env assertion.
## Evidence
