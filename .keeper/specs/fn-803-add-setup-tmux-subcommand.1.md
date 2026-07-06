## Description

**Size:** M
**Files:** cli/setup-tmux.ts (new), cli/keeper.ts, test/setup-tmux.test.ts (new), test/keeper-cli.test.ts

### Approach

Build `cli/setup-tmux.ts` on the `cli/dash.ts` module shape: export
`main(argv)` + a `HELP` string, parse with `node:util` `parseArgs`
(`--kill-sessions` boolean, `--help`), neutralized `import.meta.main`.
Export pure helpers separately from the spawn layer (the exec-backend
"build argv arrays purely, spawn separately" split) with an injectable
sync-spawn seam matching the `Bun.spawnSync` shape (Buffers for
stdout/stderr; `exitCode === null` means signal-killed — treat as failure;
`tmux` ENOENT surfaces as a clear "tmux not found" error, not a stack
trace).

Default run: kill `=dash` tolerating any non-zero (no server / no session
both mean "nothing to kill"), then rebuild dash per the dotfiles recipe —
detached `new-session -d -s dash -c ~/code/keeper -x <W> -y <H>` where
W/H come from `tmux display -p '#{client_width}'/'#{client_height}'` when
`$TMUX` is set, else `tput cols`/`tput lines` (validate numeric output,
not just exit code), else 200x50; first pane runs the argv triple
`["zsh","-ic","keeper board; exec $SHELL"]` (never a single shell
string); `set-option -w main-pane-width '50%'`; then for each of
autopilot/jobs/git/builds/usage: `split-window -d` with the zsh -ic
wrapper followed immediately by `select-layout main-vertical` (cadence is
load-bearing — splitting all five then laying out once fails "no space
for new pane"); select the board pane at the end via its `#{pane_id}`
captured with `split-window -P -F '#{pane_id}'` / `display -p` rather
than positional pane targets. Then the
ensure-loop: for each of `autopilot`, `background`, `foreground`,
`has-session -t =<name>` (stderr captured, any non-zero = absent) else
`new-session -d -s <name> -c ~/code/keeper -e KEEPER_TMUX_SESSION=<name>`
— the `-e` stamp mirrors exec-backend's session mint so hook attribution
matches daemon-minted sessions. Existing sessions are never touched.
NEVER attach or switch-client.

`--kill-sessions`: gate on server liveness first (`list-sessions`
non-zero → no server → nothing to kill, nothing busy, proceed straight to
setup). Sweep the three work sessions (NOT dash — it rebuilds
unconditionally either way) with
`list-panes -s -t =<name> -F '#{session_name}\t#{window_index}\t#{pane_current_command}\t#{window_name}'`
— TAB-delimited, free-text `window_name` LAST with a bounded split so an
embedded tab can't corrupt the command field, and the spawn env wrapped
in `localeDefaultedEnv` imported from `src/exec-backend.ts` (pure
exported helper, read-only reuse — NOT routing through the ExecBackend
API; a C-locale tmux client sanitizes TABs to `_` and the sweep would
silently parse empty, defeating the safety gate). A pane is busy when
`pane_current_command` is not in {zsh, bash, sh, fish, dash} (with or
without leading dash). Busy + TTY pair (`process.stdout.isTTY === true &&
process.stdin.isTTY === true`, the cli/jobs.ts precedent): print a
`session:window  window_name → command` table and a y/N prompt via
`node:readline` (create the interface only after the TTY check;
`rl.close()` on every path; EOF/Ctrl-D = no = abort). Busy + non-TTY:
print the table to stderr, exit 1, kill nothing. Confirmed or no busy
panes: kill all four sessions (dash + the three), then run the normal
setup pass. `autopilot` is deliberately NOT exempt even though it is the
daemon's `MANAGED_EXEC_SESSION` (import the constant from
`src/exec-backend.ts` instead of duplicating the literal) — live
autopilot workers appear as busy panes in the table and the human
decides at the prompt.

Mid-build tmux failure (any split/set-option non-zero): fail loud — exit
non-zero printing the failing tmux argv + its stderr. A half-built dash
is acceptable; the next run's unconditional kill+rebuild recovers it.

HELP documents both flags and the foreground-only `pane_current_command`
caveat (backgrounded jobs behind an idle shell read as not-busy).

Register in `cli/keeper.ts`: append `"setup-tmux"` to `SUBCOMMANDS`, add
a one-shot-style USAGE line (do NOT extend the snapshot-capable footnote
list), add the lazy handler. Update `test/keeper-cli.test.ts`: the
`makeHarness` handlers map is an exhaustive `Record<Subcommand, ...>` and
the `isSubcommand` block asserts per name — both fail until updated.

### Investigation targets

**Required** (read before coding):
- cli/dash.ts:1-72 — subcommand module template (HELP + main + parseArgs + neutralized import.meta.main)
- ~/code/dotfiles/bin/.local/bin/keeper-dash — authoritative dash recipe; drop its reuse branch (lines 20-25) and attach tail (lines 46-50)
- cli/keeper.ts:26-41, 44-79, 145-165 — SUBCOMMANDS / USAGE / handlers registration points
- src/exec-backend.ts:114 — MANAGED_EXEC_SESSION constant; :180-204 — `=` exact-match + `-e KEEPER_TMUX_SESSION` mint precedent; :270-285 — TAB-last list-panes discipline; :298-312 — localeDefaultedEnv
- test/exec-backend.test.ts:42-73 — makeSpawnStub canned-table idiom; :113-220 — pure-builder argv assertions
- test/keeper-cli.test.ts:48-62, 172-189 — harness handlers map + isSubcommand assertions to extend

**Optional** (reference as needed):
- cli/jobs.ts:584-587 — TTY-pair gate precedent
- cli/usage.ts:784-788 — Bun.spawnSync Buffer-shape usage in this repo

### Risks

- `--kill-sessions` confirmed against a live `autopilot` session kills in-flight daemon-dispatched workers; the confirm table is the only gate, so the sweep's accuracy (locale, TAB parsing) is safety-critical.
- A C-locale sweep silently classifies every pane idle — the localeDefaultedEnv wrap on the list-panes spawn is mandatory, not cosmetic.
- Positional pane targets are brittle after layout changes — use captured pane ids.
- Two concurrent setup-tmux runs can race on the dash kill/mint; accepted for an experiment, no lock.

### Test notes

Fast tier (`test/setup-tmux.test.ts`, NOT added to the package.json
blocklist): pure argv builders via `toEqual` (dash build plan incl.
sizing branches and zsh -ic triples; ensure-loop args; kill plan), busy
classification with canned TAB-delimited output (shell vs non-shell,
leading-dash shells, tab-embedded window names, empty sweep), and
decision logic (busy+non-TTY → abort plan, no-busy → kill-all plan)
through the injectable spawn stub (makeSpawnStub model). `bun run
test:full` before landing — the dispatch edit and
test/keeper-cli.test.ts only run in the full tier. Manual smoke: the
epic's Quick commands, run both inside and outside tmux.

## Acceptance

- [ ] `keeper setup-tmux` twice in a row exits 0 both times; the second run rebuilds `dash` and leaves `autopilot`/`background`/`foreground` untouched (same windows/panes)
- [ ] Runs inside and outside tmux without attaching or switch-clienting; non-TTY stdout is fine on the default path
- [ ] `dash` is built per recipe: 6 panes (board main + autopilot/jobs/git/builds/usage), main-vertical, every pane a `zsh -ic '…; exec $SHELL'` argv triple, explicit `-x`/`-y` sizing with the $TMUX/tput/200x50 fallback chain
- [ ] Absent work sessions are created with `-c ~/code/keeper` and `-e KEEPER_TMUX_SESSION=<name>`; `new-session` for them never fires when the session exists
- [ ] `--kill-sessions` with no busy panes kills all four sessions without prompting, then rebuilds
- [ ] `--kill-sessions` with busy panes prints the session:window/name/command table; `y` proceeds, `n`/EOF aborts exit 1; non-TTY stdin aborts exit 1 — in all abort cases nothing was killed
- [ ] With no tmux server running: default run creates everything; `--kill-sessions` proceeds without error or prompt
- [ ] `keeper setup-tmux --help` documents `--kill-sessions` and the foreground-only busy-scan caveat
- [ ] Fast tier green; `bun run test:full` green (incl. updated keeper-cli dispatch test)

## Done summary
Added 'keeper setup-tmux' (cli/setup-tmux.ts): rebuilds the dash session and ensures the autopilot/background/foreground work sessions via direct Bun.spawnSync, with a --kill-sessions busy-pane confirmation gate. Registered in the dispatcher; documented in README + docs/exec-backend.md.
## Evidence
