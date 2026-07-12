## Overview

Mechanically enforce wrapped-cell delegation so a wrapped `work:worker` can never
implement natively with claude tokens. Today enforcement is prompt-only and it
fails under drift (a recent wave: three gpt-cell workers held the correct wrapped
body yet implemented natively with sonnet). With `worker_provider` pinned to codex
every future work dispatch is wrapped, so the guard is load-bearing immediately.

The design has two coupled halves: (1) a producer-injected env marker at the
wrapped-cell work launch boundary, and a new eighth PreToolUse hook `wrapped-guard`
that denies ALL source-editing to a marked wrapped worker; (2) a dumb-courier
rewrite of the wrapped worker contract so the wrapper never needs to edit source —
the codex leg owns implementation, tests, and lint iteration (driven via
`keeper agent run --resume`), and the wrapper owns only launch/wait/report and the
keeper close-out (`commit-work` + `plan done`). Because the wrapper never authors
content, the guard is a single-state total edit-denial: no envelope gate, nothing
forgeable.

## Quick commands

- `bun test test/wrapped-guard.test.ts` — the guard decision table (allow/deny + deny-precedence + shell-bypass corpus)
- `bun test test/exec-backend.test.ts test/agent-launch-config.test.ts` — marker carriers in the byte-pinned launch argv
- `bun scripts/vendor-corpus.ts --check && bun test plugins/prompt/test/parity.test.ts` — rendered-worker parity after the contract rewrite

## Acceptance

- [ ] A marked wrapped worker is denied every source-editing vector (direct Edit/Write/MultiEdit/NotebookEdit and in-tree Bash write vectors) while its delegation + close-out surface (keeper agent run/--resume/wait, keeper commit-work/plan done, read-only + staging git, test runners) stays permitted.
- [ ] The guard is inert for any unmarked session (human or non-wrapped subagent) and fails closed (deny) only when the marker is present; every path exits 0.
- [ ] The wrapped worker contract no longer instructs the wrapper to edit source; lint/test iteration is delegated back to the leg via harness resume, and only the keeper close-out remains wrapper-owned.
- [ ] A wrapped-cell work dispatch injects the marker from BOTH the autopilot producer and the manual `keeper dispatch` path, keyed on effective-cell wrappedness (not the provider pin).
- [ ] An advisory, producer-probed surface flags a wrapped-cell task done-stamped with no provider-leg result envelope, without any fold reading fs/wall-clock.

## Early proof point

Task that proves the approach: task 2 (the guard hook + its decision table). If the
Bash allowlist cannot cleanly permit the leg-launch and close-out while denying the
shell-bypass corpus, the design needs the leg-launch mechanism revisited (native
detach vs. allowlist exception) before the contract rewrite lands.

## References

- File overlap (NOT wired as an epic dep, so this epic can run native-first ahead of the board): `fn-1252-edit-claims-conflict-prevention` task .2 writes `src/reconcile-core.ts` + `src/autopilot-worker.ts`, colliding with the producer-marker (task 1) and detection (task 4) tasks here; run this epic in a focused window rather than concurrently with fn-1252 lanes, or the worktree resolver absorbs the fan-in conflict.
- File overlap (NOT wired): `fn-1263-stale-tree-commit-sweep-guards` task .2 writes `CLAUDE.md` + `CONTEXT.md`, colliding with the docs task (task 5) here; same sequencing caveat.
- Existing guard precedents to reuse, not re-implement: `plugins/keeper/plugin/hooks/escalation-guard.ts` (shell lexer, command-family allowlist, fail-closed-when-marked), `wrong-tree-guard.ts` (`extractBashTargets`, `TreeProbe`, repo-tree bounding, `makeLogSink`), `branch-guard.ts` (`agent_id`/`agent_type` subagent keying).
- Env-injection seam: `src/exec-backend.ts` `buildKeeperAgentLaunchArgv` (~:1110-1214), following the `KEEPER_ESCALATION_ROLE` carrier block.

## Best practices

- **Allowlist, never blocklist, for the Bash decision:** Claude Code's own regex blocklist fell to 8 documented bypasses (CVE-2025-66032). Reject the entire shell-operator/expansion surface (`; | || && & > >> < << $( ) backticks ${...} $VAR` newline) before any family classification, then allow exact subcommands with no unenumerated flags.
- **Deny re-entrant wrappers unconditionally:** `sh -c`/`bash -c`/`xargs`/`find -exec`/`env`/`nohup` reopen an exec context the classifier cannot see into — reuse escalation-guard's `stripWrappers`/`WRAPPERS` handling.
- **In-tree write is more than redirects:** `git apply`/`git am`/`patch`/`cp`/`mv`/`tar -x` inject content without Edit/Write — the allowlist must treat these as denied write vectors, not just heredoc/redirect/`tee`/`sed -i`.
- **Fail closed-to-deny on parse ambiguity while still exiting 0:** exit-0 is about not crashing the human's session, never a license to allow-through on error.
