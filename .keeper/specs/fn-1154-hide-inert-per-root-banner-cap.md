## Overview

The `keeper board` / `keeper autopilot` TUI header renders a `per-root N` cap
that has no effect under worktree mode (each ready task gets its own cap-1
lane and the per-root cap is deliberately ignored — concurrency is DAG-width),
plus a `(stored N)` annotation that advertises an activation which never
happens. The cap only governs while worktree mode is OFF, where it floors to 1
(one worker per shared checkout). Gate the per-root segment on worktree mode so
the header only surfaces controls that actually govern dispatch in the current
mode.

## Quick commands

```
bun test test/autopilot.test.ts
```

## Acceptance

- [ ] The header shows a `per-root` segment only when worktree mode is OFF; it is absent when worktree mode is ON.
- [ ] No `(stored …)` annotation appears in the header in any mode.
