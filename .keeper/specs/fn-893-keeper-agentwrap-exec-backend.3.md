## Description

**Size:** S
**Files:** cli/dispatch.ts

Make the manual `keeper dispatch` CLI honor the configured exec backend so a
hand-launched worker also goes through agentwrap when `exec_backend: agentwrap`
(today it hardcodes tmux).

### Approach

- At the backend-resolve site (cli/dispatch.ts:363-367) thread `backendType: resolveConfig().execBackend` and the resolved `agentwrapPath` into `resolveExecBackend(...)` (currently called WITHOUT `backendType`, so it always picks tmux). Manual dispatch uses `ensureLaunched` (session-agnostic) — the agentwrap backend overrides it too, so the same agentwrap invocation path applies.
- Keep the default path (no config / `exec_backend: tmux`) byte-identical.

### Investigation targets

**Required:**
- cli/dispatch.ts:363-367 — the `resolveExecBackend({noteLine})` call missing `backendType`.
- cli/dispatch.ts MainDeps `LaunchFn`/`QueryFn` injectable seams (for the test).
- src/db.ts `resolveConfig()` — to read `execBackend` + `agentwrapPath` here.

### Risks

- This file overlaps open epic fn-887 (also edits `cli/dispatch.ts`) — different function, rebase if it lands first.
- Don't change the tmux-default manual-dispatch behavior.

### Test notes

A cli/dispatch test (fake backend via `MainDeps`): with `exec_backend: agentwrap` configured, the resolved backend builds the agentwrap argv; with tmux/default, the existing tmux argv. Assert no behavior change on the default path.

## Acceptance

- [ ] `keeper dispatch` resolves the backend from config (`backendType` + `agentwrapPath` threaded through cli/dispatch.ts:363).
- [ ] With `exec_backend: agentwrap`, a manual dispatch launches via agentwrap; default/tmux path unchanged.
- [ ] Dispatch test green.

## Done summary

## Evidence
