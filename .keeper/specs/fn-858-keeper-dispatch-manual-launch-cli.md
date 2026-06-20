## Overview

`keeper dispatch` is a manual escape hatch to fire one `claude` worker into a
tmux window by hand, parallel to the server-side autopilot reconciler. Two
mutually-exclusive modes: a **plan form** (`keeper dispatch <work|close>::<id>`)
that resolves the canonical `/plan:<verb> <id>` prompt and cwd from the daemon's
`epics` projection, and a **free form** (`--prompt "<text>"` / `--prompt-file
<path>`) that launches an arbitrary prompt. It launches CLIENT-SIDE via
`resolveExecBackend(...).ensureLaunched(...)` — no daemon RPC, no synthetic
events, no reducer/migration changes — so re-fold determinism and the
five-surface RPC-write invariant hold by construction. It targets the current
tmux session by default, falling back to the managed `foreground` session when
not inside tmux.

## Quick commands

```bash
# plan form — dispatch a task or epic-close, into the current/foreground session
keeper dispatch work::fn-1-foo.2
keeper dispatch close::fn-1-foo --session background
# plan form — preview without launching
keeper dispatch work::fn-1-foo.2 --dry-run
# free form — arbitrary prompt into a named session
keeper dispatch --name scratch --prompt 'investigate the flaky test in X' --session foreground
keeper dispatch --name review --prompt-file ./notes/review.md
# force past the race guard when autopilot is unpaused / a slot is live
keeper dispatch work::fn-1-foo.2 --force
```

## Acceptance

- [ ] `keeper dispatch <work|close>::<id>` resolves prompt + cwd from the daemon and launches a worker into the resolved tmux session.
- [ ] `keeper dispatch --prompt`/`--prompt-file` launches an arbitrary prompt; `--name` is required in free form.
- [ ] Session resolution: `--session` > `$KEEPER_TMUX_SESSION` > `$TMUX`-gated current session > `foreground`; the resolved session is echoed.
- [ ] Plan-form race guard refuses (unless `--force`) when a live/pending slot exists or autopilot is unpaused, naming the tripped condition.
- [ ] No daemon RPC, synthetic event, reducer, or migration is added; the launch is purely client-side.
- [ ] `bun run test:full` passes (exec-backend / dispatch / CLI paths).

## Early proof point

Task that proves the approach: `.1` (shared dispatch plumbing — the pure
`src/dispatch-command.ts` module + decoupled validator + `"$@"` argv builder).
If it fails (e.g. the `BadParamsError` decouple drags the server-worker graph
into the leaf module): fall back to keeping `parseDispatchKey` in `rpc-handlers`
and having the CLI carry its own copy of the validator + verb set, leaving the
new module builder-only.

## References

- Client-side exec-backend precedent: `cli/jobs.ts:717` (`focusPane`).
- Launch port: `src/exec-backend.ts:657` `ensureLaunched`; `:246` `buildTmuxNewWindowArgs` (the `=`-exact-match gap at `:256`); `:203` `has-session` uses `=`.
- Command builders to mirror (do NOT modify — byte-pinned): `src/autopilot-worker.ts:249` `buildWorkerCommand`, `:670` `buildLaunchArgv`, `:258` `--agentwrap-no-confirm`.
- cwd rules: `src/autopilot-worker.ts:939` (work) / `:1012` (close).
- Validator to extract: `src/rpc-handlers.ts:363` `parseDispatchKey` / `rejectDispatchIdToken` (throws `BadParamsError` from `./server-worker:49`).
- One-shot read precedent (file-local, lift it): `cli/autopilot.ts:498` `roundTrip` / `:607` `sendControlRpc`; `resolveSockPath` from `src/db`.
- Collections: `src/collections.ts:145` `epics` (nested `tasks[]` carry `target_repo`; epic `project_dir`), `:492` `autopilot_state`, `:547` `pending_dispatches`.
- tmux probe pattern: `cli/setup-tmux.ts:355` (`$TMUX`-gated); managed sessions `autopilot`/`background`/`foreground`/`dash`.
- `claude` interactive initial prompt is positional-only (no native file/stdin path) — verified via `claude --help`; the argv size cap is unavoidable.

## Docs gaps

- **`cli/keeper.ts`**: register `dispatch` in `SUBCOMMANDS`, the `USAGE` block, and the lazy handler map (this IS the registration, landed in `.3`).
- **`README.md`**: add a `keeper dispatch` bullet to `## Example clients` (near the `autopilot.ts` bullet, clarifying server-side reconciler vs client-side escape hatch) and to the exec-backend consumer list in `## Architecture`.
- **`docs/exec-backend.md`**: add `cli/dispatch.ts` as a third client-side consumer in the consumer table + Overview.
- AGENTS.md is a symlink to CLAUDE.md — never edit both. No `keeper/api.py` / `.keeper/specs` change (no schema touch).

## Best practices

- **Pass the prompt as a `"$@"` positional arg, never interpolated into the `-c` body** — set an explicit `argv[0]` slot or all positionals shift. Avoids every shell-quoting class (`$`, backticks, `$(...)`, newlines).
- **Reject NUL bytes before exec** — a NUL truncates the C-string argv silently.
- **Cap per-arg prompt size ~96 KB** — under Linux `MAX_ARG_STRLEN` (128 KiB per arg), which E2BIGs even below total `ARG_MAX`.
- **Target tmux sessions with the `=` exact-match prefix** — bare `-t name` prefix/glob-matches (`back` → `background`); interactive convenience, unsafe programmatically.
