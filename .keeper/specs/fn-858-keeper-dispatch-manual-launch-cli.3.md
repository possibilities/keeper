## Description

**Size:** M
**Files:** cli/dispatch.ts (new), cli/keeper.ts, test/keeper-cli.test.ts, src/exec-backend.ts, test/exec-backend.test.ts, README.md, docs/exec-backend.md

The keystone: the `keeper dispatch` command wiring the `.1` builders and `.2`
read helper into a client-side launch, plus the tmux session-target hardening
it depends on for safety, plus docs.

### Approach

- **`cli/dispatch.ts`** (`main(argv)`, `node:util` parseArgs, `allowPositionals:true`):
  - Mode detection + mutual exclusion: exactly one of a positional `verb::id` OR `--prompt`/`--prompt-file`. Both → arg fault (exit 2). Free form REQUIRES `--name`.
  - Plan form: validate the key via `.1`'s validator; resolve cwd by querying `epics` (`.2`'s `queryCollection`, filter `epic_id`) — work: walk the parent epic's `tasks[]` for `target_repo ?? epic.project_dir`; close: `epic.project_dir`. Empty cwd or unknown id → clear error (distinguish daemon-unreachable from not-found), exit 1, launch nothing. Bake `--name <verb>::<id>` so the hook binds a jobs row (board-visible, autopilot dedups post-bind). Prompt = `defaultPlanPrompt`.
  - Race guard (plan form, skip with `--force`): read `pending_dispatches` (filter verb+id) and `autopilot_state.paused`; best-effort scan live/`working` jobs for the plan key. Refuse and NAME the tripped condition if any holds.
  - Free form: `--cwd` ?? `process.cwd()`; read `--prompt-file` bytes (validate exists/readable) or take `--prompt`; run `.1`'s NUL/96 KB guard (exit 2 on violation). `--name` is the claude session name + correlation key — document that a `verb::id`-shaped `--name` binds to that plan row (feature+hazard).
  - Session resolution order: `--session` > `$KEEPER_TMUX_SESSION` (non-empty) > `$TMUX`-gated `tmux display-message -p '#{session_name}'` > `foreground`. Echo the resolved session; when falling back to `foreground` outside tmux, print a `tmux attach -t foreground` hint.
  - Optional `--model`/`--effort` passthrough → `.1`'s builder. Launch via `resolveExecBackend({ noteLine }).ensureLaunched(session, argv, cwd, "")` (UNNAMED window — the renamer labels plan-form windows; free-form stays unnamed). Surface `{ok:false,error}` to stderr + exit 1 on launch failure; mint NO synthetic event.
  - `--dry-run`: print resolved session/cwd/key-or-name/prompt-source + the full launch argv; launch nothing. `--help` → stdout, exit 0.
- **Register** in `cli/keeper.ts`: `SUBCOMMANDS` (`:22`), `USAGE` (`:44`), lazy handler map (`:149`); add the handler entry to `test/keeper-cli.test.ts`'s map.
- **Harden `src/exec-backend.ts`**: change `buildTmuxNewWindowArgs` target from `${session}:` to `=${session}:` (exact-match — closes the `back`→`background` prefix-match gap). Autopilot/restore/renamer always pass exact managed names, so this is safe; update `test/exec-backend.test.ts` expected args.
- **Docs**: `README.md` `## Example clients` bullet + `## Architecture` consumer list; `docs/exec-backend.md` consumer table + Overview (third client-side consumer). Forward-facing prose only.

### Investigation targets

**Required** (read before coding):
- cli/autopilot.ts:27,866-878 — `parseArgs` options + `die`/exit taxonomy to mirror (die→1, arg fault→2, `--help`→0).
- cli/jobs.ts:711-740 — the client-side `resolveExecBackend(...).focusPane` precedent (construction + `noteLine`).
- src/exec-backend.ts:246-268 — `buildTmuxNewWindowArgs` (the `=` hardening), `:657-673` `ensureLaunched`, `:49` `LaunchResult`.
- src/collections.ts:145-213 (`epics` filters + nested `tasks` json), `:491-557` (`autopilot_state`, `pending_dispatches` filters).
- cli/setup-tmux.ts:355 — `$TMUX`-gated probe; `:40-46` managed session names.
- cli/keeper.ts:22,44,149 + test/keeper-cli.test.ts — the 3-touch registration + the handlers-map test.

**Optional** (reference as needed):
- src/autopilot-worker.ts:939-947,1012-1018 — cwd resolution rules to mirror.
- src/derivers.ts:34 — `SPAWN_VERB_REF_RE` (the managed `verb::id` correlation pattern the free-form `--name` hazard note references).
- README.md ~234,559,865 + docs/exec-backend.md ~24,55 — doc insertion points.

### Risks

- The `=` hardening touches a shared builder — `bun run test:full` is MANDATORY and `test/exec-backend.test.ts` must be updated for every caller's expected args.
- TOCTOU between the race-guard read and launch is inherent for a client-side manual hatch — acceptable; document it. `jobs` has no `plan_verb`/`plan_ref` filter, so the working-job check is a client-side scan or best-effort.

### Test notes

`test/keeper-cli.test.ts`: routing for `dispatch`. New dispatch-handler tests (with injected socket/backend stubs): mode mutual-exclusion, free-form `--name` required, session resolution order, plan-form cwd resolution + miss, race-guard refuse/`--force`, `--dry-run` prints-and-no-launch, exit codes. `test/exec-backend.test.ts`: `=`-prefixed new-window target. Run `bun run test:full`.

## Acceptance

- [ ] `keeper dispatch work::<id>` / `close::<id>` resolves prompt+cwd and launches into the resolved session; unknown id / empty cwd errors cleanly (exit 1).
- [ ] `--prompt` / `--prompt-file` launch with required `--name`; NUL/oversize prompts rejected (exit 2); mode mutual-exclusion enforced (exit 2).
- [ ] Session resolution order + echo + not-in-tmux `foreground` attach hint behave as specified.
- [ ] Plan-form race guard refuses unless `--force`, naming the tripped condition; `--dry-run` launches nothing.
- [ ] `buildTmuxNewWindowArgs` uses `=`-exact-match; `test/exec-backend.test.ts` updated; `bun run test:full` passes.
- [ ] `dispatch` registered in `cli/keeper.ts` (3 touches) + `test/keeper-cli.test.ts`; README + docs/exec-backend.md updated.

## Done summary

## Evidence
