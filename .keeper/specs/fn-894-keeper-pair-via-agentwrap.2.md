## Description

**Size:** M
**Files:** cli/pair.ts, src/pair-command.ts, src/pair/prompts/ (ported assets), test/pair-command.test.ts

### Approach

New root verb `keeper pair send <prompt-file> --cli claude|codex --model <m> --effort <e>
--role <r> --read-only --output <path>`, mirroring `keeper dispatch`'s structure (a thin
`cli/` entry + a `src/` command module + an argv builder like `buildDispatchLaunchArgv`).
Flow: assemble the prompt (prepend the selected role's system-prompt text + the read-only
directive when `--read-only`) → launch `agentwrap <cli> --agentwrap-tmux
--agentwrap-tmux-detached --agentwrap-no-confirm` with the native model/effort/read-only
flags → `agentwrap wait-for-stop` then `agentwrap show-last-message` (from task .1) to get
the final answer → write `--output` as YAML mirroring pairctl's contract (`message` = final
answer, plus `transcript_path` / `session_id` drill-down) via write-temp-then-rename → emit
`[keeper-pair] started` / `completed` / `failed` on stdout (the Monitor contract). Port
pairctl's role prompts as in-repo assets under `src/pair/prompts/`. Read-only posture =
directive + claude `--disallowed-tools Edit,Write,NotebookEdit` (codex: bypass-sandbox +
`--enable web_search_request`, NOT `-s read-only`) + a git changed-files snapshot taken in
the partner's cwd around the wait → `read_only_violation`. Install a SIGTERM handler that
emits `[keeper-pair] failed` AND kills the tmux window; same on timeout. Strip `CLAUDE*`
env before the pane, as pairctl does.

### Investigation targets

**Required** (read before coding):
- ~/code/arthack/apps/pairctl/pairctl/run_send_message.py — Monitor two-line contract, SIGTERM handler, atomic output write, the start+terminal guarantee.
- ~/code/arthack/apps/pairctl/pairctl/helpers.py:286-672 — `READ_ONLY_DIRECTIVE`, git-snapshot backstop, final-message handling, `CLAUDE*` env strip.
- ~/code/arthack/apps/pairctl/config/prompts/*.txt — role prompts to port (default / planner / codereviewer / coplanner).
- ~/code/arthack/apps/pairctl/config/{claude,codex}.yaml — read-only posture (codex bypass + `--enable web_search_request`).
- src/dispatch-command.ts (`buildDispatchLaunchArgv`) + cli/dispatch.ts — keeper's agentwrap argv + verb pattern to mirror.

**Optional**:
- test/dispatch-command.test.ts, test/resume-descriptor.test.ts — argv-builder test patterns.

### Risks

- Read-only via `--disallowed-tools` is leaky (Bash `echo >`, git after text-deny); the git-snapshot is *detection* not prevention — matches pairctl, but state the limitation in the skill (task .3).
- The partner runs in a detached pane / different process tree; the git snapshot must run in the partner's cwd, around the `wait-for-stop`, not in keeper's cwd.
- tmux-window reaping is new (pairctl had no window) — ensure no leaked panes on timeout/kill.
- Binds on agentwrap's launch JSON `schema_version`; assert it and fail loud on drift.

### Test notes

keeper-root `test/pair-command.test.ts`: argv-builder shape (flags per `--cli`/`--read-only`), output-YAML assembly, the read-only flag set. This trips `bun run test:full` per CLAUDE.md (new tested builder at keeper root) — run it before landing. Mock/stub the agentwrap subprocess for the compose flow.

## Acceptance

- [ ] `keeper pair send` launches a partner via agentwrap, waits, and writes the final answer to `--output` (YAML, `message` + drill-down keys).
- [ ] `--read-only` strips edit tools + prepends the directive + reports `read_only_violation` when the tree changed; codex `--read-only` keeps web search.
- [ ] Emits `[keeper-pair] started` then exactly one terminal line (`completed`/`failed`) in all paths, including SIGTERM/timeout; kills the tmux window on failure.
- [ ] Role `--role` selects a ported in-repo prompt; unknown role fails loud.
- [ ] `bun run test:full` passes.

## Done summary
Built keeper pair send: a thin CLI + dep-free src/pair-command.ts leaf that fans a task to claude/codex via agentwrap (launch -> wait-for-stop -> show-last-message), ports pairctl's role prompts/read-only directive/git-snapshot backstop/two-line Monitor contract, and writes the partner's final answer to --output as YAML with transcript drill-down.
## Evidence
