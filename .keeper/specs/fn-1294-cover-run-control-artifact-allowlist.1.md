## Description

Adds the missing negative coverage for finding F1: the security guard
`isRunControlArtifact` in `src/agent/run-capture.ts` (the `kill_window_command`
command-tail allowlist — `/(?:^|\/)tmux$/` argv[0], even/odd `-L`/`-S` socket
pairing, `kill-window` / `-t` / `@[0-9]+` tail). Evidence path from the audit:
the guard has no direct test, and the sole `malformed_control` case in
`test/agent-run-capture.test.ts` (`readArtifact: () => ({ nope: true })`, ~L935)
fails at the earlier `schema_version` check and never exercises the command-tail
branch — so a loosened allowlist would ship green while the panel consumer
executes `kill_window_command` verbatim via `runTmuxCommand`.

Add negative cases (a `test.each` matrix is a good fit) covering a control
whose owner tuple matches but whose `kill_window_command` is a well-formed
object with a hostile/mis-shaped command, e.g. `["tmux","kill-server"]`,
`["rm","-rf","/"]`, `["tmux","kill-window","-t","not-a-window"]`, and an
odd-length socket-arg run. Assert both `isRunControlArtifact(...) === false`
directly AND that `cancelOwnedRunFromControlArtifact` returns
`malformed_control` with no tmux command executed.

Files: `test/agent-run-capture.test.ts` (assertions), `src/agent/run-capture.ts`
(guard under test — no source change expected unless a genuine gap surfaces).

## Acceptance

- [ ] `isRunControlArtifact` returns false for each hostile/mis-shaped `kill_window_command` shape (wrong verb, non-`@N` target, odd socket-arg run, non-`tmux` argv[0])
- [ ] `cancelOwnedRunFromControlArtifact` yields `malformed_control` for those shapes and issues zero tmux commands
- [ ] the targeted suite and typecheck/lint pass

## Done summary
Run-control artifact allowlist rejection covered in agent-run-capture suite; operator re-run 83/0; landed via plain-git escape (live-leg claim wedge, leg 6922fe55 discharged) as e134b8fc on the epic lane
## Evidence
- Commits: e134b8fc
- Tests: bun test agent-run-capture 83/0 (operator re-run in lane)