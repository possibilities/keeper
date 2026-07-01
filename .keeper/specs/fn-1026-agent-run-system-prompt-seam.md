## Overview

Increment 4 (sketch-step 5) of flattening `keeper pair` into a fat `keeper agent`: add `--system-file <path>` / `--system <text>` to `agent run` — the system-prompt seam the eventual agent-backed-subagent (pair-wrapper) needs. This increment composes it as a UNIFORM `System:`-prepend into the prompt for ALL harnesses (claude/codex/pi) caller-side — transport-proven (matches pair's `assemblePrompt`), main.ts-only, NO launch-builder change. `pair send` UNCHANGED. The higher-fidelity native `--append-system-prompt` (claude/pi) + codex `developer_instructions` path is a deliberate future upgrade (documented, NOT built here). Builds on fn-1019 + fn-1022 (both done).

## Quick commands

- `bun run test` — full suite green
- `bun run typecheck` — `tsc --noEmit` clean
- (out-of-band) `keeper agent run --system-file /tmp/sys.txt claude "hi"` — the `System:` block prepends into the prompt positional

## Acceptance

- [ ] `agent run --system-file`/`--system` compose a uniform `System:`-prepend for ALL harnesses (caller-side); mutual-exclusion + missing-file → `bad_args`.
- [ ] `pair send` byte-stable; managed launches byte-identical; NO native `--append-system-prompt` anywhere.
- [ ] Flags documented (dispatch help + `cli/agent.ts` header + README); `bun test` green.

## Early proof point

Task `.1` is the whole increment. If the uniform prepend proves insufficient (a caller needs real fidelity now): the native `--append-system-prompt` path (claude confirmed viable interactively) is the ready upgrade.

## References

- Increment 4 of a 5-increment pair→agent flattening; builds on fn-1019 (agent run) + fn-1022 (`--read-only` pattern), both done. Next: step 6 (collapse `pair panel`).
- **Fidelity note (deliberate):** uniform `System:`-prepend is user-turn text (decaying, overridable by repo content the partner reads), NOT a privileged system prompt. Chosen for simplicity/uniformity this increment. Native `--append-system-prompt(-file)` (claude — confirmed to work in interactive mode per the official Claude Code CLI reference; pi recognized-but-unconfirmed, risks a silent identity-clobber) + codex `-c developer_instructions` are the documented future fidelity upgrade — do NOT build here.
- The subagent-wrapper (destination) works with the `System:`-prepend seam — panels rely on the same mechanism today.
- **Security:** do NOT put security-relevant constraints in a user-turn `System:` block — it is overridable; a real system prompt (the future native upgrade) is the resilient home.

## Docs gaps

- **src/agent/dispatch.ts (`USAGE` :64 / `KEEPER_AGENT_HELP` :158)**: add `--system-file`/`--system` to the `run` synopsis + per-harness behavior — part of the deliverable.
- **cli/agent.ts header (:7-11) + README ~:1429**: add the flags alongside `--read-only` — revise in place (forward-facing).

## Best practices

- **File over inline for large text:** `--system-file` avoids ARG_MAX (the body can be large); the handler reads it (`bad_args` on missing). Prefer it over `--system` for big bodies.
- **Mirror the proven join:** reuse `assemblePrompt`'s block order (read-only directive → `System:` text → user prompt); don't reinvent the compose.
- **Uniform, not native:** every harness gets the `System:`-prepend this increment — no `--append-system-prompt`, no `LaunchPosture` field; the native upgrade is a separate future step.
