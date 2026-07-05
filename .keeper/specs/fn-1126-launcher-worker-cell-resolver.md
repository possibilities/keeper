## Overview

Manual `keeper dispatch work::fn-N.M` launches a plan worker with no per-cell `--plugin-dir` — the orchestrator has no work:worker to spawn, contradicting the composition docs; only autopilot's reconcile path resolves the cell. Extract one launcher-owned resolver (pure compose + the two on-disk guards, reject-as-data) that both callers consume: autopilot keeps its sticky DispatchFailed mapping, dispatch fails loud, and the transport stays untouched.

## Quick commands

- `bun test test/dispatch-cli.test.ts test/autopilot-worker.test.ts test/exec-backend.test.ts` — dispatch threading + existing guard/argv pins
- `keeper dispatch work::<todo-task> --dry-run` — spec carries the resolved cell --plugin-dir

## Acceptance

- [ ] Manual dispatch of a plan task launches with the task's resolved worker-cell plugin or exits non-zero on any resolution reject, autopilot behavior is byte-unchanged, and both paths share one resolution seam
