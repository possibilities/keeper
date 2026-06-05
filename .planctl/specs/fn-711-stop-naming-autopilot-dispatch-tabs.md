## Overview

When the autopilot reconciler dispatches a worker, the managed
`ExecBackend.launch` forwards the `verb::id` key as the zellij
`new-tab --name`, labeling the tab. The tab name is purely cosmetic
(fn-678 — no control path reads it back; reap is `tab_id`-driven), and
we want dispatched tabs launched unnamed. The `--name verb::id`
correlator baked into the worker argv (the SessionStart dedup key) stays
untouched — only the zellij tab label is dropped.

## Acceptance

- [ ] The managed `launch` path launches the dispatch tab WITHOUT a
  `--name` (mirroring the restore `ensureLaunched` path); the
  `--name verb::id` baked into the worker argv is unchanged
- [ ] `bun run typecheck` + `bun test test/exec-backend.test.ts` green
