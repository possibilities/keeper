## Description

**Size:** M
**Files:** src/exec-backend.ts, plugin/hooks/events-writer.ts, cli/jobs.ts, src/types.ts, CLAUDE.md, test/exec-backend.test.ts, test/events-writer.test.ts

### Approach

Build `createTmuxBackend` in src/exec-backend.ts implementing the post-deletion
3-op interface (`launch`, `focusPane`, `ensureLaunched`), mirroring the zellij
factory shape: standalone pure argv builders + injectable `spawn`, reusing
`runCapture`/`SpawnFn`/`LaunchResult`/`streamToText`. Builders (community-verified
forms): session probe `["tmux","has-session","-t","=<session>"]`; mint
`["tmux","new-session","-d","-s","<session>","-e","KEEPER_TMUX_SESSION=<session>"]`
with TERM/COLORTERM carried in spawn env exactly like the zellij mint (LaunchAgent
env is stripped); launch chains in ONE invocation:
`["tmux","new-window","-t","<session>:","-c",cwd,"-e","KEEPER_TMUX_SESSION=<session>","-P","-F","#{pane_id}","--",...argv,";","set-option","-p","remain-on-exit","on"]`
— note the literal `;` argv element (tmux command separator; verified working on
3.6b: dead panes persist with pane_dead=1 + pane_dead_status). Managed windows
stay UNNAMED (`launch` keeps its unused `name` arg — seam for the future naming
system). `focusPane(session, paneId)`: `select-window -t <paneId>` then
`select-pane -t <paneId>` (pane ids are server-global; never name-based targets —
colons in names break target parsing). `ensureLaunched` = per-call has/mint +
new-window with `-e KEEPER_TMUX_SESSION=<targetSession>` (and `-n <name>` only
when the restore caller passes one). `resolveExecBackend` gains a `backendType`
switch (zellij default).

Hook: add the tmux arm to `execBackendEnvMeta` (sentinel `TMUX`, sessionIdEnvVar
`KEEPER_TMUX_SESSION`, paneIdEnvVar `TMUX_PANE`) and extend
`backendExecCoordsFromEnv` (events-writer.ts:246-267): zellij sentinel checked
FIRST (nested wins zellij), then `TMUX`; stamp type/pane always, session only when
`KEEPER_TMUX_SESSION` is present (human sessions → NULL, filled by task 3). Pure
env reads, no fork, import budget unchanged. Update the CLAUDE.md scraping fence
to name TMUX/TMUX_PANE/KEEPER_TMUX_SESSION as permitted every-event reads, and
the stale ZELLIJ-only JSDoc in src/types.ts (:219-238, :397-408).

Focus routing: cli/jobs.ts (:644-707) constructs the backend per selected ROW via
`resolveExecBackend({ backendType: row.backend_exec_type })` — NULL/unknown type
skips with the existing flash-message pattern (generalize "[no zellij pane]").
Mixed zellij+tmux DBs route each row correctly.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:594-871 — createZellijBackend + resolveExecBackend; the shape to mirror
- src/exec-backend.ts:297-320 — execBackendEnvMeta seam (the comment already names tmux)
- plugin/hooks/events-writer.ts:246-267 — backendExecCoordsFromEnv sentinel gating
- test/exec-backend.test.ts:54-81 — makeSpawnStub pattern for argv-capture tests
- cli/jobs.ts:644-707 — the v-key focus path and its guard

**Optional** (reference as needed):
- test/events-writer.test.ts:994-1049 — existing sentinel test cases to mirror for tmux
- CLAUDE.md "Scraping is scoped" bullet — the fence to extend in place

### Risks

- The chained `;` separator must be a SEPARATE argv element after the worker argv; if tmux mis-parses, the fallback (epic Early proof point) is a second targeted `set-option -p -t <returned pane id>` call — the `-P -F '#{pane_id}'` return exists for exactly that.
- Sub-ms race: a worker that exits before the chained set-option lands loses its dead pane (window auto-closes). Accepted residual — note it in the backend doc comment, no mitigation.
- `new-session -e` requires tmux ≥3.2 — acceptable floor (3.6b verified); note the floor in the module header.

### Test notes

Pure builder tests + makeSpawnStub factory tests in fast tier (argv assertions for
all three ops, ensure-mint env carry, session-gone retry parity if implemented).
Hook sentinel tests in test/events-writer.test.ts fast tier (TMUX present/absent,
both sentinels present → zellij, KEEPER_TMUX_SESSION present/absent). A scratch
`tmux -L` integration test for launch+remain-on-exit is slow-tier. `bun run
test:full` mandatory.

## Acceptance

- [ ] `createTmuxBackend` passes argv-stub tests for launch/focusPane/ensureLaunched; managed windows unnamed; all targets id-based or `=`/trailing-colon forms
- [ ] Hook stamps type='tmux' + TMUX_PANE on every event under tmux; KEEPER_TMUX_SESSION stamps session for managed launches; zellij wins when nested; pure env reads only
- [ ] `resolveExecBackend` switches on backend type; jobs-board focus routes per-row and skips NULL-type rows gracefully
- [ ] CLAUDE.md fence + types.ts JSDoc updated; `bun run test:full` green

## Done summary

## Evidence
