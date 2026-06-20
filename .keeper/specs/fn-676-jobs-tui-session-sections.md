## Overview

Rework the `keeper jobs` TUI (`cli/jobs.ts`) so the backend coords become a
session-less pill, jobs group by zellij session instead of
interactive/autopilot, and the pill collapses under a per-job disclosure
caret shown on every row.

## Quick commands

```bash
bun test test/jobs.test.ts
```

## Acceptance

- [ ] Backend coords render as a session-less pill `[<tab> p<pane>]` (no `·`, no `zellij` type, no session id), with graceful fallbacks
- [ ] Sections group by `backend_exec_session_id` (`--- <session> ---`) with a `--- (no session) ---` fallback, replacing the interactive/autopilot split
- [ ] The backend pill line is collapse-controlled (shown only when the job is expanded, alongside sub-agent lines) and every job row shows a disclosure caret in insert mode
- [ ] `test/jobs.test.ts` updated to match all three shape changes and passes
