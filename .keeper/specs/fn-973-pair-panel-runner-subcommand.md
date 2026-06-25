## Overview

The `plan:panel-runner` subagent hand-rolls its panel fan-out in shell — detaching legs with
`setsid` and bounding its poll with `timeout`, neither of which exists on stock macOS — so its
first run on darwin flails (probing the environment, re-launching) until it improvises a portable
workaround. This epic extracts that orchestration into a tested, cross-OS `keeper pair panel
start|wait` subcommand (Bun.spawn + a JS poll loop, zero coreutils), shrinking the agent to: write
the prompt file → call the subcommand → spawn the judge. The subcommand runs identically on macOS
and Linux and is regression-locked by a fast-tier test.

## Quick commands

- `keeper pair panel --help` — usage for the new sub-verb
- `keeper pair panel start /tmp/q.md --panel default` — launch a panel, get the manifest JSON
- `keeper pair panel wait --dir <dir> --chunk 540` — block one chunk, get the verdict JSON
- `bun run test:full` — fast + slow tiers green (process-spawn path)
- A real `/plan:panel "<question>"` run completing without the macOS flail = end-to-end proof

## Acceptance

- [ ] `keeper pair panel start|wait` exists, runs cross-OS with no `setsid`/`timeout`/`gtimeout` in the path
- [ ] The panel-runner agent drives the panel via the subcommand; the `PANEL_RUN_FAILED` contract is preserved
- [ ] `bun run test:full` green; a real `/plan:panel` run completes first-try with no environment-probing flail
- [ ] No keeper.db write, no RPC widening, no third-party deps

## Early proof point

Task that proves the approach: `.1` (the subcommand) — its fast-tier test asserting detached legs
survive `start`'s exit plus the 124/verdict semantics is the keystone. If it fails (e.g. Bun's
detached semantics differ from the nohup-wrapper assumption): fall back to a thin bundled shell
helper script the agent invokes, still nohup-based, without the TS test harness.

## References

- `plugins/plan/agents/panel-runner.md` — the agent whose Steps 0-4 this replaces
- `cli/pair.ts` / `src/pair-command.ts` / `src/agent/config.ts` — the pair-send + preset primitives composed
- Bun detached-child caveat on macOS — drives the `nohup` double-fork wrapper over bare `detached:true`
- Soft coordination: fn-971 also edits `plugins/keeper/skills/pair/SKILL.md` (a separate section)

## Docs gaps

- **plugins/keeper/skills/pair/SKILL.md**: add a `panel start|wait` section + `argument-hint` (task `.2`)
- **cli/pair.ts JSDoc + HELP**: document the new sub-verb (task `.1`)
- **plugins/plan/CLAUDE.md**: verify the "content-blind orchestrator" line still holds (task `.2`)

## Best practices

- **Cross-platform detach:** interpose `sh -c 'nohup "$@" … &'` to reparent the leg to launchd — raw `Bun.spawn({detached:true}).unref()` is reported to die on macOS parent-exit.
- **Atomic sentinels:** temp-then-rename within the SAME dir (`os.tmpdir()` is a different APFS volume on macOS → `EXDEV`).
- **Liveness:** the leg's guaranteed `[keeper-pair] completed|failed` log line is authoritative; `process.kill(pid,0)` is a backstop only (pid-reuse, no `/proc` starttime on macOS).
- **Bounded wait:** `Date.now()` deadline + `Bun.sleep`, never a busy loop or a shell `timeout`.
