## Description

**Size:** M
**Files:** cli/resume.ts, cli/keeper.ts, cli/descriptor.ts, src/agent/foreground-resume.ts, src/agent/resume-policy.ts, src/resume-resolve.ts, test/resume-cli.test.ts, test/agent-resume-policy.test.ts, test/resume-resolve.test.ts, test/keeper-cli.test.ts

### Approach

Add foreground `keeper resume <session-reference>` as a human-facing continuation primitive distinct from detached partner resume and crash restore. Resolve to one canonical native target, retain pid/start-time Refuse-live, validate the transcript-derived project directory, and reuse harness descriptors, launch configuration, and foreground process control rather than constructing a shell or native argv ad hoc.

A TTY ambiguity offers a numbered candidate picker; JSON or non-TTY mode returns candidates and launches nothing. From the wrong directory, launch nothing and print a shell-escaped `cd -- <project> && keeper resume <qualified-id>` command. Missing/conflicting artifacts, cwd, binaries, or resume targets fail explicitly; unavailable standalone liveness is not invented and native harness safeguards remain authoritative.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/resume-policy.ts:177 — existing jobs-only resolution and Refuse-live
- src/agent/main.ts:2322 — detached `keeper agent resume` behavior and launch planning
- src/agent/run.ts:44 — foreground stdio, signals, process group, and exit propagation
- src/resume-resolve.ts:1 — disk-anchored Claude cwd and artifact existence gates
- src/agent/harness.ts:1 — supported harness descriptors and native resume argv

**Optional** (reference as needed):
- test/agent-dispatch.test.ts:432 — current resume failures/candidate rendering
- test/resume-resolve.test.ts:89 — duplicate, rehomed, and vanished cwd fixtures

### Risks

Wrong-session continuation, shell injection in printed recovery, duplicate writers, vanished worktrees, account routing, terminal control, and native trust prompts are high-impact failure modes.

### Test notes

Keep process launches behind injected seams. Cover TTY choice, non-TTY ambiguity, exact qualified rerun, wrong/same cwd, paths with shell metacharacters, live/recycled pids, standalone unknown liveness, missing binary/artifact/cwd, harness mismatch, signals, and exit status.

### Detailed phases

1. Factor a pure foreground-resume decision/launch plan over catalog resolution, liveness, cwd, and harness descriptors.
2. Add deterministic candidate rendering and injected TTY picker; never prompt when stdout/stdin is non-TTY or JSON is requested.
3. Add shell-safe wrong-directory recovery rendering without executing a shell.
4. Delegate same-directory launch to Keeper's foreground process seam with native argv, trust, account route, and lifecycle carriers intact.
5. Register the top-level command and pin error/problem-code behavior.

### Alternatives

Reusing detached `keeper agent resume` as a subprocess is rejected because it requires tracked jobs and tmux semantics. Direct shell execution is rejected because ids/titles are user-controlled and native process control would be lost.

### Non-functional targets

No shell execution, no silent cwd fallback, no implicit latest candidate, exact signal/exit propagation, bounded picker output, and zero transcript text in diagnostics.

### Rollout

The command lands before old history readers disappear so operators can validate selection and recovery independently. It remains separate from detached partner and generation restore commands.

## Acceptance

- [ ] `keeper resume` accepts every canonical exact Session-reference form and always passes the resolved full native id to the matching supported harness.
- [ ] Multiple matches prompt only on a TTY; non-TTY/JSON returns structured candidates and launches nothing; no newest-selection escape hatch exists.
- [ ] Positive pid/start-time live identity refuses continuation with the Agent Bus recovery, while absent standalone liveness evidence is reported without fabricating a live or dead fact.
- [ ] Wrong cwd, missing cwd, missing artifact, conflicting identity, unsupported harness, and missing binary each launch nothing and return distinct actionable failures.
- [ ] Wrong-directory recovery is shell-safe and re-invokes `keeper resume` with an unambiguous qualified id; same-directory execution uses shell-free native argv.
- [ ] Foreground execution preserves account routing, native trust/permission behavior, terminal job control, signals, and child exit status.
- [ ] Focused resume policy, cwd resolution, CLI, and routing tests pass without starting a real harness.

## Done summary

## Evidence
