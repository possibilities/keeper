## Overview

Add a session-agnostic `focusPane` operation to the `ExecBackend`
interface and wire a `v` key in `cli/jobs.ts` to focus the selected
job's zellij pane. The `ExecBackend` interface becomes the single
"port unit" carrying both session-bound lifecycle ops (`launch` /
`closeByName`, managed autopilot session) and session-agnostic ops
(`focusPane` / `resolveTabForPane`, any live session). Fold the
pre-existing free `resolveTabForPane` function onto the interface in
the same change so the abstraction is consistent (no half-on-interface
split). `launch` / `closeByName` and their tests stay untouched.

## Quick commands

```bash
bun test test/exec-backend.test.ts test/backend-worker.test.ts test/jobs.test.ts
```

## Acceptance

- [ ] `ExecBackend` exposes `focusPane(session, paneId)` and
  `resolveTabForPane(session, paneId)`; free `resolveTabForPane`
  export dropped.
- [ ] `v` in `cli/jobs.ts` insert mode focuses the selected job's
  zellij pane via `backend.focusPane`.
- [ ] All exec-backend / backend-worker / jobs tests pass.
