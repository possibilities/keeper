## Description

Finding F1 (fn-658 audit): the ~200-line TUI shell harness — sidecar writers
(writeSidecars, prevFrameTmp, meta/lifecycle paths), emitLifecycle,
scheduleFlashRestore, handleCopyKey, SIGINT handler, and color-enabled gate —
is copy-pasted nearly verbatim across cli/board.ts and cli/jobs.ts (auditor
confirmed by reading both files), with further siblings in cli/git.ts,
cli/usage.ts, cli/autopilot.ts. Only the keeper-board/keeper-jobs basename and
the renderBody function differ per sibling.

Extract a createViewShell({ script, renderBody }) factory into src/view-shell.ts
that owns the shared lifecycle; each TUI sibling becomes a thin caller.

## Acceptance

- [ ] src/view-shell.ts (or equivalent) exports createViewShell({ script, renderBody })
- [ ] cli/board.ts and cli/jobs.ts delegate lifecycle to createViewShell with no harness copy
- [ ] Remaining siblings (git.ts, usage.ts, autopilot.ts) migrated, or each explicitly deferred with a one-line rationale comment
- [ ] bunx tsc --noEmit passes; bun test suite passes; no behavior change

## Done summary

## Evidence
