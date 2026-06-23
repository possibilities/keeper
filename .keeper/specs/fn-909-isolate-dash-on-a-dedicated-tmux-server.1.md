## Description

**Size:** M
**Files:** cli/setup-tmux.ts, README.md, test/setup-tmux.test.ts

### Approach

Two coupled changes to `keeper setup-tmux`, both rewriting the same
functions in cli/setup-tmux.ts (one cohesive PR). NOTE: this lands AFTER
fn-908 — work against the post-fn-908 shape (WORK_SESSIONS =
`[MANAGED_EXEC_SESSION, "work"]`, dash priority renamed); the line numbers
below are PRE-fn-908 and will have shifted, so re-derive exact sites.

**(1) Dash → dedicated `tmux -L dash` server.** Inject `-L dash` as a
GLOBAL flag (immediately after `"tmux"`, BEFORE the subcommand) into EVERY
dash-targeting builder: buildDashNewSessionArgs, buildSetMainPaneWidthArgs,
buildDashSplitArgs, buildSelectLayoutArgs, buildSelectPaneArgs (the
captured `#{pane_id}` is only re-targetable on the same server, so
select-pane MUST carry `-L dash` too). Strongly prefer a single pure helper
— e.g. `dashTmux(...args) => ["tmux","-L","dash",...args]` — so no site is
missed. In rebuildDash, replace `buildKillSessionArgs(DASH_SESSION)` with a
new pure exported `buildKillDashServerArgs()` returning EXACTLY
`["tmux","-L","dash","kill-server"]`, routed through the tolerant `run`
(not `runChecked`) so a first-ever run with no dash server yet is fine.
This teardown runs on EVERY invocation, ungated by `--kill-sessions`. Stamp
`-e TMUX=` on the dash new-session to clear the inherited outer-server
`$TMUX`. Keep resolveDashSize BARE (NO `-L dash`) — it sizes the detached
dash session by probing the attached/current server's client, and the new
dash server has no client yet.

**(2) Stop creating `autopilot`; split the session constant by role.**
Split the single WORK_SESSIONS into a PROVISION set `["work"]` (looped by
ensureWorkSessions) and a SWEEP/KILL set `["work", MANAGED_EXEC_SESSION]`
(looped by sweepBusyPanes + the `--kill-sessions` kill path). Derive
RESTORABLE from the SWEEP/KILL set filtered by `!== MANAGED_EXEC_SESSION`
(so the autopilot exclusion stays meaningful) → `["work"]`. Drop
DASH_SESSION from the `--kill-sessions` kill loop (ALL_SESSIONS): dash is
now torn down unconditionally by rebuildDash on its own socket, so a
default-server `kill-session -t =dash` there would hit nothing.

**Resilience (resolved):** make a dash-server rebuild failure FAIL-OPEN —
catch it, warn to stderr, and continue so `work` is still provisioned and
the command exits 0. Today rebuildDash uses `runChecked` and a dash failure
aborts before ensureWorkSessions; once dash is an isolated, deprecated
server its failure must not block provisioning the human's `work` session.

Update the module header docstring + HELP text + the success-message attach
hint (`tmux -L dash attach`) and the README mirrors. State the end state
only (provisions `work`; autopilot swept-not-created; dash on `-L dash`) —
no change-history narration (forward-facing docs rule).

### Investigation targets

**Required** (read before coding; PRE-fn-908 line refs):
- cli/setup-tmux.ts:425-449 — rebuildDash (kill→kill-server, -L dash on
  new-session/splits/layout/select-pane, fail-open boundary).
- cli/setup-tmux.ts:160-239 — the dash argv builders to carry `-L dash`.
- cli/setup-tmux.ts:65-84 — DASH_SESSION/WORK_SESSIONS/ALL_SESSIONS to
  split into PROVISION vs SWEEP/KILL; DASH_SUB_PANES unchanged.
- cli/setup-tmux.ts:350-377 — resolveDashSize MUST stay BARE.
- cli/setup-tmux.ts:453-506 — ensureWorkSessions (PROVISION),
  sweepBusyPanes (SWEEP/KILL), killAllSessions (drop dash), RESTORABLE
  (derive from SWEEP/KILL).
- cli/setup-tmux.ts:600-633 — main: the offer-ordering comment (~602-609)
  claims rebuildDash "mints a NEW tmux server" that shifts the
  kill-anchored generation window; dash is now a SEPARATE socket and no
  longer perturbs the default-server anchor — correct the comment so it
  stays true, and keep the offer computed before ensureWorkSessions.
- test/setup-tmux.test.ts — makeSpawnStub keys on `cmd[0]:cmd[1]`
  (~:42-43): with `-L dash` injected, dash calls key on `tmux:-L`, so the
  canned board-pane-id stdout for the dash new-session must be re-keyed or
  rebuildDash captures an empty boardPaneId. The busy-gate refuse-branch
  assertion (~:391-393) uses `KILL_VERBS.has(c[1])`; the dash teardown is
  now `c[1]==="-L"`, so update that negative assertion to catch
  `c[1]==="-L" && c[3]==="kill-server"`.

**Optional** (reference as needed):
- src/exec-backend.ts:115,288-298,766-826 — confirms autopilot is
  daemon-minted on the default server (no -L).
- README.md setup-tmux onboarding step + setup-tmux.ts architecture mirror.

### Risks

- **Bare `kill-server` is catastrophic** — it kills the DEFAULT server
  where the human's live `work` (and daemon `autopilot`) sessions live.
  Every dash teardown MUST be `tmux -L dash kill-server`. This is the
  safety crux; pin it with an exact-argv test.
- **`-L` flag position** — `-L dash` AFTER the subcommand is silently a
  subcommand option and targets the default server. It must be a global
  flag (right after `"tmux"`). A single `dashTmux()` helper is the safest
  guard against a missed/misplaced site.
- **Test false-greens** — existing dash assertions keyed on
  `cmd[1]==="new-session"`/`"split-window"` will match ZERO dash calls once
  `cmd[1]==="-L"`, silently passing against nothing. Re-key the stub and
  assert full argv arrays.
- **RESTORABLE derive-source** — must derive from the SWEEP/KILL set (which
  still contains autopilot); deriving from PROVISION makes the
  `!== MANAGED_EXEC_SESSION` filter a silent no-op (correct by accident now,
  a latent bug later).

### Test notes

- All tests synthetic via the injectable SyncSpawnFn seam — NO real tmux
  (fn-904). If a contract genuinely needs real tmux-server behavior, name
  it `*.slow.test.ts` and add it to the fast-tier ignore list.
- Add: buildKillDashServerArgs returns exactly `["tmux","-L","dash",
  "kill-server"]`; each dash builder's full argv includes `-L dash` in
  global position; the dash new-session carries `-e TMUX=`; provision set
  mints only `work`; sweep/kill set is `["work","autopilot"]`; a present
  `work` is left untouched on a normal run; dash teardown runs even when
  `--kill-sessions` is NOT passed; an aborted `--kill-sessions` (refuse
  branch) still emits NO kill of any kind (including no `-L dash
  kill-server`, which runs only after the gate); a fail-open dash rebuild
  still provisions `work`.
- Re-key the makeSpawnStub canned board-pane-id stdout for the now-`tmux:-L`
  dash new-session so rebuildDash captures the board pane id.
- Run `bun run test:full` before landing (CLI/tmux process paths the fast
  tier skips).

## Acceptance

- [ ] Every dash-targeting tmux call carries `-L dash` as a global flag;
  teardown is `buildKillDashServerArgs()` = `["tmux","-L","dash",
  "kill-server"]`, run on every invocation regardless of `--kill-sessions`,
  through the tolerant `run`.
- [ ] No bare `kill-server` is ever emitted — pinned by an exact-argv test.
- [ ] The dash new-session carries `-e TMUX=`; resolveDashSize stays BARE.
- [ ] ensureWorkSessions provisions only `work`; sweepBusyPanes + the
  `--kill-sessions` kill path use the `["work","autopilot"]` sweep/kill
  set; DASH_SESSION is dropped from that kill loop; RESTORABLE is `["work"]`
  derived from the sweep/kill set.
- [ ] A present `work` session is left untouched on a normal run (test).
- [ ] A dash-server rebuild failure warns and continues; `work` is still
  provisioned and the command exits 0 (test).
- [ ] Header docstring, HELP, the success-message attach hint
  (`tmux -L dash attach`), and the README mirrors describe the end state.
- [ ] `bun run test:full` passes.

## Done summary
Isolated the dash dashboard onto a dedicated tmux -L dash server (dashTmux helper + buildKillDashServerArgs teardown, -e TMUX= on new-session, fail-open rebuild) and split setup-tmux into PROVISION_SESSIONS [work] vs SWEEP_KILL_SESSIONS [work,autopilot].
## Evidence
