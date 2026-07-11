## Overview

/plan:work wielder sessions error once per session ("`prompt` is required when `stop` is not true") by calling the harness ScheduleWakeup tool to wait on their backgrounded work:worker subagent. Teach the work skill template — and /plan:close's hand-authored skill — that subagent spawns are backgrounded, waiting means ending the turn, and the completion task-notification is the only wake path.

## Quick commands

```bash
keeper prompt render-plugin-templates --project-root . && (cd plugins/prompt && bun run capture-oracle && bun test) && (cd plugins/plan && bun test test/consistency-skills.test.ts)
```

## Acceptance

- [ ] The rendered /plan:work skill instructs the orchestrator, for every work:worker spawn (initial, warm resume, cold respawn), that the spawn is backgrounded, waiting means ending the turn, the completion task-notification is the only wake path, and ScheduleWakeup/Monitor/sleep are never used to wait on a worker; no "Wait for the worker to finish" phrasing remains.
