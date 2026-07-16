## Description

**Size:** S
**Files:** cli/handoff.ts, cli/descriptor.ts, test/handoff.test.ts

### Approach

Add `--capture` to `keeper handoff`, plus the launch-triple knob it unlocks (accept a `--preset <triple>` or `--model`/`--effort` pair, mirroring the dispatch CLI's shape); triple flags without `--capture` are a usage error. Validate CLI-side before any RPC send — an invalid triple or flag combination exits with a distinct documented exit code (alongside the existing dup-slug exit 3) and never mints an event; the RPC re-validation from the persistence task is the backstop, not the primary gate. Update the usage/--help/--agent-help blocks and the exit-code list to document the new flags and codes. Default path stays byte-identical: a no-flag invocation builds the same frame as today.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/handoff.ts:52-94,192-210,264-431 — flag table, usage blocks, frame builder, exit codes
- cli/descriptor.ts:376 — HANDOFF_FLAGS registration
- cli/dispatch.ts — the --preset/--model/--effort flag shape to mirror

**Optional** (reference as needed):
- src/agent/launch-handle.ts — triple parsing/validation helpers available client-side (post-fn-1282 surface)

### Risks

- Flag semantics drifting from `agent run --capture <path>` (which takes a path): here capture is a boolean request and the path is daemon-derived — the help text must make that distinction explicit.

### Test notes

Extend test/handoff.test.ts: flag parsing, usage errors (triple without capture, invalid triple), exit codes, and a no-flag frame byte-equal to the pre-change frame.

## Acceptance

- [ ] `keeper handoff --capture [--preset|--model/--effort]` validates client-side and sends the capture fields; invalid combinations exit non-zero with a distinct documented code and send nothing
- [ ] `keeper handoff` without new flags produces a request identical to pre-change behavior
- [ ] --help/--agent-help document the flags, their capture-only constraint, and the exit codes

## Done summary
Captured handoff results surfaced through the handoff/descriptor CLIs (+ fast-test lint update); worker-verified full test:gate 9167/0 + operator re-run handoff suite 25/0; landed via plain-git escape (multi-leg claim wedge, sessions discharged) as e5d331b7 on the epic lane
## Evidence
- Commits: e5d331b7
- Tests: worker: test:gate 9167/0, bun test handoff 25/0 (operator re-run in lane)