## Overview

`keeper bus wake planner@<epic>` is broken: it spawns a tmux window running
`claude --resume "<name>" --agentwrap-no-confirm`, but `--agentwrap-no-confirm`
is a `keeper agent` wrapper flag that real claude rejects, and the
`claude → keeper agent claude` alias is zsh-only while the wake wraps its
command in bash — so the resumed planner dies on `error: unknown option` and
the wake silently no-ops (tmux `new-window` returns 0, so `runWake` reports
`launched`). This epic makes the resume LAUNCH command alias-independent (an
absolute `keeper agent` launcher prefix, injected) and quoting-safe (a
positional-`"$@"` shell body), applied to BOTH launch producers — bus wake and
crash-restore — while keeping the human-facing DISPLAY form unchanged. End
state: a wake (and a crash-restore replay) reliably resumes its planner in any
shell, with shell metacharacters in the session name handled safely.

## Quick commands

- `keeper agent claude --resume "<a-real-session>"` — runs the launcher (strips
  `--agentwrap-no-confirm`, forwards `--resume`), proving the LAUNCH token
  re-attaches a session in a scratch tmux pane.
- `bun test test/bus-wake.test.ts test/restore-agents.test.ts test/resume-descriptor.test.ts`
  — the rewritten byte-pins plus the new quoting-hardening case.
- `bun run test:full && bun run test:hygiene` — full tier (launch process
  paths the fast tier skips) plus the no-real-git/test-hygiene gate.

## Acceptance

- [ ] `keeper bus wake` resumes an offline planner into `agentbus` with no
  `error: unknown option` — the silent no-op is gone.
- [ ] Both launch producers (wake + crash-restore) emit the alias-independent,
  quoting-safe LAUNCH form; the DISPLAY form is byte-unchanged.
- [ ] A session name carrying shell metacharacters resumes safely (positional,
  no interpolation).
- [ ] Docs reworded from "byte-identical across three producers" to
  "one DISPLAY form + two LAUNCH producers."

## Early proof point

Task that proves the approach: `.1` (the only task) — its rewritten
`test/bus-wake.test.ts` byte-pin asserting the alias-independent positional
argv is the keystone. If it fails (e.g. the `$0`/`$@` positional mapping is
wrong): fall back to the literal `keeper` token form, still positional-hardened,
which sidesteps the absolute-prefix threading while keeping the alias-free fix.

## References

- `src/dispatch-command.ts:206-220` — the positional-`"$@"` launch precedent
  this mirrors (fixed-literal `-c` body, `$0` slot filled, caller data in
  `"$@"`); note it `exec`s claude — the resume body must NOT.
- `src/keeper-agent-path.ts:82` — `buildLauncherArgvPrefix`, the absolute
  `[<bun>, <abs cli/keeper.ts>, "agent"]` prefix injected into the LAUNCH form.
- Overlap: `fn-938` (strip-agent-bus-chat-broadcast) also edits `cli/bus.ts` +
  `CLAUDE.md` — wired as a dep to serialize the shared doc edits.
- Out of scope (future epic): the agentwrap-tmux transport migration
  (Approach C) — extend `buildAgentwrapLaunchArgv` with a `--resume` target and
  reconcile the `@keeper_managed=agentbus` window marker.

## Docs gaps

- **CLAUDE.md** (wake bullet ~line 39): reword "resumes that creator via
  `claude --resume`" to name the alias-independent LAUNCH form.
- **README.md** (Agent Bus ~3238-3240 + crash-restore ~3072-3075): reword the
  "three resume-command producers byte-identical" claim to the DISPLAY/LAUNCH
  split.
- **cli/bus.ts** (wake help ~131-135): drop the bare-`claude` framing so no
  reader concludes a `claude` alias is required for wake.
- **src/resume-descriptor.ts / src/bus-wake.ts / scripts/restore-agents.ts**
  JSDocs: revise "one formula, three call sites" to "one DISPLAY form + two
  LAUNCH producers."

## Best practices

- **Positional args, never interpolation:** cwd/target ride as `"$@"`
  positionals; a `-c` body that interpolates a path or session name is a
  shell-injection vector. [practice-scout / OWASP]
- **`cmd ; exec $SHELL -l -i`, never `&&` or an exec'd cmd:** `;` always reaches
  the hold-open shell; exec-ing the command kills the pane-hold. [practice-scout]
- **`-l -i` both load-bearing:** login sources profile PATH, interactive sources
  rc; the absolute prefix is PATH-independent so it survives either drifting.
  [practice-scout]
