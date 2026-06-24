## Description

**Size:** M
**Files:** src/resume-descriptor.ts, src/bus-wake.ts, scripts/restore-agents.ts,
cli/bus.ts, test/resume-descriptor.test.ts, test/bus-wake.test.ts,
test/restore-agents.test.ts, CLAUDE.md, README.md

### Approach

Split the shared resume formula into a LAUNCH form and a DISPLAY form. Add a
new PURE builder in `src/resume-descriptor.ts` that produces the LAUNCH argv:
a login-shell wrapper `[shell, "-l", "-i", "-c", <body>, <$0-slot>, ...positionals]`
whose `-c` body is the FIXED literal `"$@" ; exec "$0" -l -i` (no caller data
interpolated). All command tokens ride as positionals: the absolute launcher
prefix (`buildLauncherArgvPrefix(process.execPath, resolveKeeperAgentPath())`
= `[<bun>, <abs cli/keeper.ts>, "agent"]`), then `claude`, `--resume`,
`<target>`, `--agentwrap-no-confirm`. The prefix is INJECTED by the caller so
the builder stays pure (mirrors how `shell` is injected into
`buildResumeLaunchArgv` today). Keep `buildResumeCommand` as the DISPLAY form
(bare `claude --resume "<target>"`, byte-unchanged) for `scripts/resume.ts`.

Rewire the two LAUNCH producers to call the new builder: `buildWakeResumeArgv`
(`src/bus-wake.ts:193`, currently bash-wrapped → BROKEN) and
`buildResumeLaunchArgv` (`scripts/restore-agents.ts:194`, injected `$SHELL`).
Resolve + thread the absolute prefix from each caller — the wake at the
`cli/bus.ts` `runWake` wiring (`process.execPath` + `resolveKeeperAgentPathDepFree`
available there), restore-agents at its own resolution point. Drop the
`cd ${cwd}` from the body entirely — the tmux transport already applies cwd via
`-c` (`restoreReplayLaunch` / `ensureLaunched`), so cwd never needs
interpolation.

Fill the `$0` slot (repeat the shell as `$0`, as `buildDispatchLaunchArgv`
does) so the first real positional is `$1` and `"$@"` runs the full command.
Keep the claude part NON-`exec` — the trailing `exec "$0" -l -i` is the
hold-open shell that must survive claude exiting. Do NOT emit any
`--agentwrap-tmux*` flag (the launch already runs inside a tmux window the
transport opened — a second would double-nest). The form must behave
identically under bash (wake) and zsh (restore): `<shell> -c 'body' a0 a1`
assigns `$0=a0, $1=a1` in both.

### Investigation targets

**Required** (read before coding):
- src/dispatch-command.ts:206-220 — `buildDispatchLaunchArgv`, the
  positional-`"$@"` precedent: fixed-literal body, `$0` slot filled by
  repeating shell, caller data only in `"$@"`. NOTE it `exec`s claude — resume
  must NOT.
- src/keeper-agent-path.ts:82-87 — `buildLauncherArgvPrefix` +
  `defaultKeeperAgentPath`; the absolute prefix to inject.
- src/resume-descriptor.ts:34-67 — `resumeTarget` (title ?? job_id, may carry
  specials) and `buildResumeCommand` (keep as DISPLAY form, stays PURE).
- src/bus-wake.ts:185-197,322-324 — `buildWakeResumeArgv` and the `runWake`
  launch call site (cwd already passed to `restoreReplayLaunch`).
- scripts/restore-agents.ts:183-203 — `buildResumeLaunchArgv` (injected `$SHELL`).
- cli/bus.ts:596-624 — `runWakeVerb` / `runWake` dep wiring; where to resolve +
  thread the prefix.
- test/dispatch-command.test.ts:192-214 — the adversarial-input byte-pin
  template for the new quoting test.

**Optional** (reference as needed):
- src/exec-backend.ts — `restoreReplayLaunch` → `launchIntoTmux` →
  `buildTmuxNewWindowArgs` applies `-c cwd`.
- src/agent/args.ts:111,164 — confirms `--agentwrap-no-confirm` is stripped by
  the launcher and `--resume` is recognized.

### Risks

- **Silent-no-op trap**: if the launched command fails, the `; exec "$0" -l -i`
  hold-open still runs and the tmux launch reports `ok:true` — masking the
  failure (the same class as the original bug). The absolute prefix is
  PATH-independent, which removes the command-not-found case; do not
  reintroduce a PATH dependency.
- **`$0`/`$@` off-by-one**: forgetting to fill the `$0` slot eats the prefix's
  first token → claude launches without resume (wrong/fresh session). Pin it
  in the byte test.
- **bash vs zsh positional parity**: wake hardcodes bash, restore injects zsh —
  confirm positional mapping is identical (it is).
- **DISPLAY form must not change**: `test/resume-descriptor.test.ts:58-89` pins
  the bare `claude --resume` DISPLAY string — keep it green.

### Test notes

- Rewrite the broken byte-pins: `test/bus-wake.test.ts:179-193` (and the
  `runWake` launch assertion ~323-348 that checks `argv[0] === "bash"`),
  `test/restore-agents.test.ts:215-248`. Assert the new shape: shell +
  `-l -i -c` + fixed-literal body + positional tokens (prefix … `claude`
  `--resume` `<target>` `--agentwrap-no-confirm`), NO `--agentwrap-tmux`,
  hold-open `exec "$0" -l -i` present, `cd` absent.
- Add a quoting-hardening test (template: `test/dispatch-command.test.ts:192-214`):
  a `resumeTarget` with single-quote / `$VAR` / backticks / `$(...)` / newline /
  `;` / leading-dash rides byte-identical as a positional, and the `-c` body
  never contains the target text. Cover both the wake and restore builders.
- `bun run test:full` + `bun run test:hygiene` mandatory (touches a launch
  process path even though the builders are pure).
- Manual: `keeper agent claude --resume "<a-real-session>"` in a scratch tmux
  pane confirms live `/resume` re-attach.

## Acceptance

- [ ] A new pure LAUNCH-form builder in `src/resume-descriptor.ts` emits a
  `<shell> -l -i -c '<fixed-literal body>'` argv with the absolute launcher
  prefix + `claude --resume <target> --agentwrap-no-confirm` riding as
  positionals; the injected prefix keeps the builder pure.
- [ ] `buildWakeResumeArgv` (bus-wake) and `buildResumeLaunchArgv`
  (restore-agents) both emit the LAUNCH form; `keeper bus wake` resumes a real
  planner with no `error: unknown option` (verified in a scratch tmux pane).
- [ ] `buildResumeCommand` DISPLAY form (`scripts/resume.ts`) is byte-unchanged
  and its byte-pin test stays green.
- [ ] The `-c` body is a fixed literal containing no cwd/target text; a
  `resumeTarget` with shell metacharacters rides byte-identical (new
  adversarial byte test passes for both builders).
- [ ] No `--agentwrap-tmux` in the resume argv; the claude part is non-`exec`;
  the `exec "$0" -l -i` hold-open is preserved; `-l -i` intact; `cd` dropped.
- [ ] Doc touch-ups land: CLAUDE.md wake bullet, README Agent Bus +
  crash-restore sections, cli/bus.ts wake help, and the
  resume-descriptor/bus-wake/restore-agents JSDocs — the "byte-identical across
  three producers" framing reworded to "one DISPLAY form + two LAUNCH producers."
- [ ] `bun run test:full` + `bun run test:hygiene` pass.

## Done summary
Split the resume descriptor into a DISPLAY form (buildResumeCommand, unchanged) and a new pure LAUNCH form (buildResumeLaunchForm): absolute keeper-agent launcher prefix + claude --resume <target> --agentwrap-no-confirm as positional $@ args. Rewired bus-wake + crash-restore onto it (alias-independent, quoting-safe); verified a real keeper agent claude --resume forwards the flag and strips --agentwrap-no-confirm (no more 'error: unknown option'). Docs reworded to one DISPLAY + two LAUNCH producers.
## Evidence
