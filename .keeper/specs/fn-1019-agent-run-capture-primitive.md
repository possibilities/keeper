## Overview

Increment 1 of flattening `keeper pair` into a fat `keeper agent`: add an additive, behavior-stable `agent run <cli> <prompt>` blocking run-and-capture primitive (composes the existing detached launch → wait-for-stop → show-last-message in ONE process, returning a uniform schema-versioned JSON result envelope) plus `agent wait <handle>` (wait+capture on an already-launched handle), preceded by golden/characterization tests that pin current behavior. ZERO behavior change to any existing path — this is the reusable substrate the later flattening increments (repoint pair, posture flags, panel collapse) sit on.

## Quick commands

- `bun test` — full suite green (the conformance surface; no test launches a real subprocess/tmux/git)
- `bun run typecheck` — `tsc --noEmit` clean
- (out-of-band, manual) `keeper agent run claude "say hi"` — emits the uniform JSON envelope carrying `message` + `transcript_path` + `resume_target`

## Acceptance

- [ ] `agent run` and `agent wait` exist as additive verbs emitting a uniform, schema-versioned JSON envelope (decision A: ONE shape for every terminal state; `outcome` + exit code carry severity).
- [ ] In-process compose holds the run-id locally — no cross-process kill margin (`PATH_CEILING_MS + SLOP_MS`) and no self-transcript-collision exposure.
- [ ] All existing paths byte-identical; golden + negative byte-pin tests lock current behavior; `bun test` green.
- [ ] Verbs + envelope documented in runtime help + README; CLAUDE.md unchanged (no new invariant).

## Early proof point

Task that proves the approach: `.2` (the run-capture primitive + uniform envelope). If it fails (the compose can't hold the pinned handle cleanly, or the uniform-envelope contract proves awkward in practice): fall back to shipping `agent wait <handle>` alone over the existing primitives and defer `agent run`'s in-process launch to a follow-up.

## References

- Increment 1 of a 6-step pair→agent flattening. Later increments (NOT yet planned as epics): repoint `pair send` → `agent run`; `--read-only` + move `ensureCodexDirTrust` into agent's codex path; `--system-file`/`--system` (prepend-for-all, then claude/pi native `--append-system-prompt`); collapse `pair panel` onto `agent run`/`agent wait`.
- In-flight non-epic handoff `scrub-agentwrap-legacy` renames legacy `agentwrap` identifiers across `src/agent/*`, `src/exec-backend.ts`, `cli/pair.ts`, `src/pair-command.ts` — the exact files this epic edits. Coordinate (land one then rebase the other, or write against the post-rename names) to avoid textual conflicts in `dispatch.ts`/`main.ts`.
- Contract decision A (uniform envelope) chosen over a split envelope/`tmuxErrorJson` surface — one shape for programmatic callers (panel legs, the future subagent-wrapper).

## Docs gaps

- **src/agent/dispatch.ts (`USAGE`/`AGENTWRAP_HELP`)**: add `run`/`wait` rows — part of the deliverable, not a separate doc task.
- **cli/agent.ts header JSDoc + src/agent/main.ts composable-verb comments**: revise in place to include the new verbs (forward-facing, no historical note).
- **README.md launcher block (~line 1412)**: add `run`/`wait` to the `keeper agent` subcommand enumeration — terse, present-tense.

## Best practices

- **JSON-only on stdout:** the envelope is the sole stdout output; diagnostics go to stderr (stdout poisoning is the top failure mode for machine-readable CLIs).
- **Full-key-set snapshot test:** assert the exact envelope key set so a forgotten `schema_version` bump fails CI.
- **Inject spawn/clock/IO seams:** unit-test the compose with fakes; never spawn a real process in `bun test`.
