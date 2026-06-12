## Description

**Size:** S
**Files:** src/exec-backend.ts, test/exec-backend.test.ts, docs/exec-backend.md

### Approach

Add two session-agnostic ops to `ExecBackend`, following `focusPane`'s
template (no session-ensure, never throws, `{ok:false,error}` envelopes,
server-global id targeting):

- `listPanes(): Promise<PaneInfo[] | null>` — one
  `tmux list-panes -a -F '#{pane_id}\t#{window_id}\t#{window_name}'`
  sweep through `runCapture` (stdout capture, 5s kill-timeout). `null` on
  degraded/missing tmux — callers skip the cycle. Parse tab-delimited
  with window_name LAST and a 2-split limit so a tab inside a window
  name cannot break the pane/window fields; skip malformed lines.
  `PaneInfo = { paneId, windowId, windowName }`.
- `renameWindow(windowId: string, name: string): Promise<LaunchResult>` —
  argv `["tmux","rename-window","-t",windowId,"--",name]`. The `--` is
  load-bearing: names may start with `-`. Fire-and-check like
  `focusPane`; a nonzero "can't find window" exit is an expected
  TOCTOU no-op for callers, returned as `{ok:false}` without noise.

Pure exported builders `buildTmuxListPanesArgs()` /
`buildTmuxRenameWindowArgs(windowId, name)` beside the existing
`buildTmux*Args` family, with the same JSDoc style (document the `--`
rule and the @N-window-id targeting rule). Update docs/exec-backend.md:
op-categories table (consumer: renamer worker; session source: per
call), public-surface prose subsections, pure-helpers table rows.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:385-417 — focusPane, the method template (envelopes, targeting, no ensure)
- src/exec-backend.ts:278-322 — runCapture (stdout capture + timeout-kill + null degrade)
- src/exec-backend.ts:134-149 — tmux identity rules + the reserved window-naming seam comment (rewrite that comment: the seam is now filled)
- test/exec-backend.test.ts:44-69 — makeSpawnStub pattern for argv + parse assertions

**Optional** (reference as needed):
- src/restore-worker.ts:580-630 — probeTmuxPanes, the existing tab-delimited list-panes parse to stay consistent with
- docs/exec-backend.md:52-56,85+,192-209 — the three doc sites gaining rows

### Risks

- fn-799 is rewriting this file; this task must start from its landed
  shape (epic dep enforces ordering).
- Window names are arbitrary user text: parse must survive tabs,
  unicode, colons, leading hyphens in names.

### Test notes

makeSpawnStub-driven: assert exact argv for both builders (incl. `--`);
parse canned list-panes output covering spaces/tabs/unicode in names and
malformed lines; never-throw on nonzero exit and on null/ENOENT spawn.

## Acceptance

- [ ] `listPanes` returns parsed `PaneInfo[]` from one `-a` sweep; `null` on degraded tmux; tab-in-name safe
- [ ] `renameWindow` argv targets `@N` window id and carries `--` before the name; never throws
- [ ] Pure builders exported and covered in test/exec-backend.test.ts
- [ ] docs/exec-backend.md op table, prose, and helpers table updated
- [ ] `bun test test/exec-backend.test.ts` passes

## Done summary

## Evidence
